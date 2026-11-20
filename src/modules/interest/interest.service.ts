import { Injectable, Logger, BadRequestException, NotFoundException, Inject, forwardRef, OnModuleInit, Optional } from '@nestjs/common';
import { RdFinancialYearClosingService } from '../rd/services/rd-financial-year-closing.service';
import { GroupInsuranceService } from '../group-insurance/group-insurance.service';
import { lockLedgerIds } from '../shared/utils/ledger-lock';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between } from 'typeorm';
import { InterestMaster, InterestPaid, Ledger } from './entities';
import { MemberMaster } from '../member/entities/member-master.entity';
import {
  UpdateSavingInterestDto,
  InterestCalculationResultDto,
  InterestRunSummaryDto,
  InterestHistoryDto,
} from './dto';
import { SystemConfigService } from '../admin/services/system-config.service';
import { FundsMaster } from '../admin/entities/funds-master.entity';
import { validateDoubleEntry } from '../shared/utils/ledger-validation';
import { generateVoucherNo } from '../shared/utils/voucher-utils';

/**
 * ES-457: the expense head the interest paid on savings is debited to. The legacy has no savings accounts and so no such
 * head (checked in the legacy MS SQL head master: only E1026 interest on compulsory deposit and E1027 interest on
 * security deposit exist), so one is created, found by its name so it survives a re-load of the head master.
 */
const SB_INTEREST_EXPENSE_HEAD_NAME = 'INTEREST PAID ON SAVINGS DEPOSIT';

/** Longest period one interest run may cover */
const MAX_INTEREST_PERIOD_DAYS = 365;
const MAX_INTEREST_RATE = 50;

/**
 * RD and CD are one deposit, and the legacy credited its interest once a year, at year end: DR E1026 (INTT ON COMPULSORY
 * DEPOSIT) / CR L1004 per member. That journal belongs to RD/CD Financial Year Closing, which calculates it with the
 * RD/CD engine. This generic period run used to credit RD to A1002 (REGULAR LOAN) and later L1004 with a placeholder
 * expense head; it no longer accepts the RD type at all, so RD/CD interest can only be posted the legacy way.
 */
function assertNotRdCd(accountType: string | undefined): void {
  const t = String(accountType ?? '').trim().toUpperCase();
  if (t === 'RD' || t === 'CD' || t === 'RD/CD' || t === 'RECURRING DEPOSIT') {
    throw new BadRequestException(
      'RD/CD interest is calculated and credited once a year in RD/CD Financial Year Closing, not here. Use that window.',
    );
  }
}

/**
 * The one rule set for an interest run, shared by the validate call and the real run.
 * Returns the first problem as a message, or null when the dates and the rate are acceptable.
 */
function interestParameterProblem(dto: { fromDate: any; toDate: any; interestRate: any }): string | null {
  const fromDate = new Date(dto.fromDate);
  const toDate = new Date(dto.toDate);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) return 'From date and to date must be valid dates';
  if (fromDate >= toDate) return 'From date must be before to date';
  const days = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
  if (days > MAX_INTEREST_PERIOD_DAYS) return `Interest period cannot exceed ${MAX_INTEREST_PERIOD_DAYS} days`;
  const rate = typeof dto.interestRate === 'string' && dto.interestRate.trim() === '' ? NaN : Number(dto.interestRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_INTEREST_RATE) return `Interest rate must be a number between 0% and ${MAX_INTEREST_RATE}%`;
  return null;
}

@Injectable()
export class InterestService implements OnModuleInit {
  private readonly logger = new Logger(InterestService.name);

  /** ES-365: widen interestpaid.account_number (was numeric(9); member numbers can have 10 digits). Idempotent, runs on every start. */
  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query(
        `DO $$ BEGIN
           IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'interestpaid' AND column_name = 'account_number'
                      AND COALESCE(numeric_precision, 0) < 18) THEN
             ALTER TABLE interestpaid ALTER COLUMN account_number TYPE numeric(18,0);
           END IF;
         END $$;`,
      );
    } catch (e: any) {
      this.logger.warn(`interestpaid.account_number widening skipped: ${e?.message ?? e}`);
    }
  }

  constructor(
    @InjectRepository(InterestMaster)
    private readonly interestMasterRepository: Repository<InterestMaster>,
    @InjectRepository(InterestPaid)
    private readonly interestPaidRepository: Repository<InterestPaid>,
    @InjectRepository(Ledger)
    private readonly ledgerRepository: Repository<Ledger>,
    @InjectRepository(MemberMaster)
    private readonly memberMasterRepository: Repository<MemberMaster>,
    @InjectRepository(FundsMaster)
    private readonly fundsRepository: Repository<FundsMaster>,
    private readonly systemConfigService: SystemConfigService,
    private readonly dataSource: DataSource,
    @Optional() private readonly rdClosing?: RdFinancialYearClosingService,
    @Optional() private readonly groupInsurance?: GroupInsuranceService,
  ) { }

  /**
   * Calculate and update saving interest for all eligible members
   */
  async updateSavingInterest(dto: UpdateSavingInterestDto): Promise<InterestRunSummaryDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`Starting interest calculation for period ${dto.fromDate} to ${dto.toDate}`);

      // Validate dates and rate (same rules as validateInterestParameters)
      const problem = interestParameterProblem(dto);
      if (problem) throw new BadRequestException(problem);
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);

      // BUG FIX 53: this was an exact 3-column match (fromDate, toDate, intType),
      // despite the error message claiming "or dates overlap" — Jan 1-31 then
      // Jan 1-Feb 28 would both post, double-crediting the overlapping days. Now a
      // real overlap check: any existing run of the same type whose range intersects
      // the requested one blocks it.
      const accountTypeCode = dto.accountType || 'SB';
      assertNotRdCd(accountTypeCode);
      // Take the lock for this account type BEFORE the overlap check: two runs started at the same moment
      // would otherwise both see "no overlap" and both post the same period (released at commit/rollback).
      await queryRunner.manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`interest_run:${accountTypeCode}`]);
      const overlapping = await queryRunner.manager.query(
        `SELECT id FROM interestmaster WHERE inttype = $1 AND frdt <= $2 AND todt >= $3 LIMIT 1`,
        [accountTypeCode, toDate, fromDate]
      );
      if (overlapping.length > 0) {
        throw new BadRequestException('Interest has already been calculated for this period or dates overlap with existing records');
      }

      // Get all eligible members (active members), optionally filtered to one member
      const allMembers = await this.getEligibleMembers();
      const eligibleMembers = dto.memberNo
        ? allMembers.filter(m => m.mbno === dto.memberNo)
        : allMembers;
      this.logger.log(`Found ${eligibleMembers.length} eligible members`);

      // BUG FIX 53: the old generateVoucherNumber() queried a table/column that don't
      // exist at all (`interest_paid`/`voucher_number` vs the real `interestpaid`/
      // `vchrno`) — confirmed live, every post crashed with "relation does not exist"
      // before anything else ran. Also produced a 10-char format ("INT2026001") against
      // a varchar(6) column. Reusing the same voucher generator used successfully
      // throughout the rest of the app (format e.g. "J00042", fits varchar(6) exactly).
      const voucherNumber = dto.voucherNumber || await generateVoucherNo(queryRunner.manager, 'J');

      // BUG FIX 53: interestmaster.id has no real DB sequence (see entity fix) —
      // must be generated explicitly before save.
      const interestMasterId = await this.getNextId(queryRunner.manager, 'interestmaster', 'id');
      const interestMaster = await queryRunner.manager.save(InterestMaster, {
        id: interestMasterId,
        intType: accountTypeCode,
        fromDate: fromDate,
        toDate: toDate,
        rate: dto.interestRate,
      });

      const memberCalculations: InterestCalculationResultDto[] = [];
      let totalInterestAmount = 0;

      // ES-457: one expense head for the whole run - the one the caller names, else the savings-interest head
      const expenseHead = dto.expenseHeadCode
        || (accountTypeCode === 'SB' ? await this.ensureSavingsInterestExpenseHead(queryRunner.manager) : undefined);

      // Calculate interest for each member
      for (const member of eligibleMembers) {
        try {
          const calculation = await this.calculateMemberInterest(
            member,
            fromDate,
            toDate,
            dto.interestRate,
            queryRunner.manager,
            accountTypeCode,
          );

          if (calculation.interestAmount > 0) {
            // BUG FIX 53: interestpaid.rowid is NOT NULL with no default (see entity
            // fix) — must be generated explicitly.
            const rowId = await this.getNextId(queryRunner.manager, 'interestpaid', 'rowid');
            // BUG FIX: payDate was never set (nothing anywhere in the codebase
            // ever writes it after this insert either — confirmed by search, not
            // a two-phase "set on payment" design). The Interest List report
            // filters by `EXTRACT(YEAR FROM paydate)`, so every posted interest
            // record was permanently invisible to that report. `post: 'Y'` is
            // already set unconditionally at insert time, so this row is
            // considered fully posted here — payDate should be too.
            await queryRunner.manager.save(InterestPaid, {
              id: interestMaster.id.toString(),
              rowId,
              mbno: member.mbno,
              wrno: voucherNumber,
              openingBalance: calculation.openingBalance,
              totalDebit: calculation.totalDebit,
              totalCredit: calculation.totalCredit,
              closingBalance: calculation.closingBalance,
              amount: calculation.averageBalance,
              interest: calculation.interestAmount,
              post: 'Y',
              paid: 'N',
              payDate: new Date(),
              voucherNumber: voucherNumber,
              accountNumber: calculation.accountNumber,
            });

            // BUG FIX 53: A1001 ("CASH IN HAND", confirmed live)/A1002 ("REGULAR LOAN")/
            // A1003 (doesn't exist) are all confirmed-wrong for their purpose here — same
            // class of gap as SB's missing A001 elsewhere this session (no real "member
            // savings/RD/FD interest liability" head exists in headmaster to point at
            // instead). Now honors dto.accountHead if the frontend supplies one (already
            // wired, just previously ignored — same one-place-fixable pattern used for
            // FD's headCode), falling back to the same flagged-wrong defaults only when
            // none is given.
            // ES-121: A1001 is CASH IN HAND and A1002 is REGULAR LOAN, so interest must never be credited to them.
            // SB interest goes to the member savings head A001 (the head SB opening and the Day Book use) and RD
            // interest to L1004 (the head RD instalments are posted under). FD is on hold and keeps its placeholder.
            // RD/CD is not here any more (ES-121): its interest is a yearly journal in RD/CD Financial Year Closing
            // (DR E1026 / CR L1004), exactly as the legacy posted it; this run refuses the RD type (assertNotRdCd).
            const GL_CREDIT_HEAD_MAP: Record<string, string> = {
              'SB': 'A001',
              'FD': 'A1003',
            };
            const glHead = dto.accountHead || GL_CREDIT_HEAD_MAP[accountTypeCode] || 'A001';

            await this.createInterestLedgerEntry(
              member,
              calculation,
              voucherNumber,
              dto.narration || `Interest credited for period ${dto.fromDate} to ${dto.toDate}`,
              queryRunner.manager,
              glHead,
              accountTypeCode,
              expenseHead,
              toDate,
            );

            // BUG FIX 53: FD interest read fdmaster.intpaid to avoid double-counting
            // (calculateMemberFDInterest computes interest-since-deposit minus intpaid),
            // but posting only ever updated `interestamount` — intpaid itself never
            // moved, so every subsequent run recomputed and reposted the exact same
            // since-inception interest again. Also, this used to apply the member's
            // *combined* interestAmount to every one of their FD rows, over-crediting
            // any member with more than one FD account (confirmed live) — now applies
            // each account's own share via the breakdown from calculateMemberFDInterest.
            if (accountTypeCode === 'FD') {
              const breakdown = (calculation as any).fdAccountBreakdown as { accountNumber: string; netInterest: number }[] | undefined;
              for (const fd of breakdown || []) {
                if (fd.netInterest <= 0) continue;
                await queryRunner.manager.query(
                  `UPDATE fdmaster SET interestamount = COALESCE(interestamount, 0) + $1,
                          intpaid = COALESCE(intpaid, 0) + $1,
                          lastintpaydate = NOW()
                   WHERE mbno = $2 AND account_number = $3 AND fdrdflag = 'F'`,
                  [fd.netInterest, member.mbno, fd.accountNumber]
                );
              }
            }

            // ES-366: the ledger got the interest credit but sbmaster.balance (read by passbook, statement and
            // dashboard) did not. Add it in the same transaction; if the account row is missing, abort the run.
            if (accountTypeCode === 'SB') {
              const upd = await queryRunner.manager.query(
                `UPDATE sbmaster SET balance = COALESCE(balance, 0) + $1 WHERE mbno::text = $2::text RETURNING mbno`,
                [calculation.interestAmount, String(member.mbno)],
              );
              if (!upd || upd.length === 0) {
                throw new Error(`Saving account row not found for member ${member.mbno}; cannot add interest to balance`);
              }
            }

            memberCalculations.push(calculation);
            totalInterestAmount += calculation.interestAmount;
          }
        } catch (error) {
          // One member's failure stops the whole run (the outer catch rolls everything back): carrying on would
          // post the run and leave this member silently without interest while the period is marked as done.
          this.logger.error(`Error calculating interest for member ${member.mbno}:`, error);
          throw new Error(`Interest calculation failed for member ${member.mbno}: ${(error as any)?.message ?? error}`);
        }
      }

      // BUG FIX 53: this built its own CR/DR pairs from each calculation's own
      // interestAmount (`[{CR, amount}, {DR, amount}]` from the same number) — that's
      // mathematically incapable of ever failing, regardless of what was actually
      // written to the ledger. Reading back the real rows just inserted (by
      // voucherNumber, within this same transaction) actually verifies something.
      // A run that pays nobody must not book the period: the catch below rolls back the interestmaster row and the
      // voucher number, so the period stays open for a later run once accounts exist. (ES-329)
      if (memberCalculations.length === 0) {
        throw new BadRequestException(
          'No account earned interest for this period, so nothing was posted. The period stays open for a later run.',
        );
      }

      const ledgerCheck = await queryRunner.manager.query(
        `SELECT trans_type, SUM(trans_amt::numeric) as total FROM ledger WHERE receipt_vchr_no = $1 GROUP BY trans_type`,
        [voucherNumber]
      );
      const drTotal = parseFloat(ledgerCheck.find((r: any) => r.trans_type === 'DR')?.total || '0');
      const crTotal = parseFloat(ledgerCheck.find((r: any) => r.trans_type === 'CR')?.total || '0');
      const validation = validateDoubleEntry([
        { transType: 'DR', amount: drTotal },
        { transType: 'CR', amount: crTotal },
      ]);
      if (!validation.valid) {
        throw new BadRequestException(
          `Double-entry validation failed: DR=${validation.drTotal}, CR=${validation.crTotal}, diff=${validation.difference}`
        );
      }

      await queryRunner.commitTransaction();

      this.logger.log(`Interest calculation completed. Total amount: ${totalInterestAmount}`);

      // Auto-queue interest notification for each member
      try {
        const { autoQueueNotification } = require('../shared/utils/auto-notify');
        for (const calc of memberCalculations) {
          if (calc.interestAmount > 0) {
            autoQueueNotification(this.dataSource, String(calc.memberNumber),
              `Interest of ₹${calc.interestAmount.toLocaleString('en-IN')} credited to your ${accountTypeCode} account for period ${dto.fromDate} to ${dto.toDate}. — FIBE Credit Society`,
              'INTEREST_CREDITED'
            ).catch(() => {});
          }
        }
      } catch {}

      return {
        totalMembers: memberCalculations.length,
        totalInterestAmount,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        interestRate: dto.interestRate,
        voucherNumber,
        calculationDate: new Date().toISOString(),
        memberCalculations,
      };

    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Interest calculation failed:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get eligible members for interest calculation
   */
  private async getEligibleMembers(): Promise<MemberMaster[]> {
    return this.memberMasterRepository.find({
      where: {
        isactive: 'Y'
      },
      order: {
        mbno: 'ASC',
      },
    });
  }

  /**
   * Get opening balance for a member as of a specific date
   * BUG FIX 53: this read `ledger.pl_balance` (the entity's `balance` field) off the
   * single most-recent prior transaction row — but pl_balance is a column nothing in
   * this codebase actually maintains as a running balance (confirmed live: every SB
   * ledger row has pl_balance = 0.0000). This meant opening balance was always ₹0,
   * regardless of real account activity — measured live impact: running interest
   * monthly instead of annually underpaid members by ~90.6%, since each month's
   * "opening balance" reset to zero instead of carrying forward. Rewritten to sum
   * every CR/DR transaction before the period start, matching the pattern already
   * used correctly by calculateMemberRDInterest in this same file.
   */
  private async getOpeningBalance(memberNo: string, date: Date, manager: any, accountType: string = 'SB'): Promise<number> {
    const result = await manager.query(
      `SELECT COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN trans_amt::numeric ELSE -trans_amt::numeric END), 0) as bal
       FROM ledger WHERE mbno = $1 AND acc_type = $2 AND trans_date < $3`,
      [memberNo, accountType, date]
    );
    return parseFloat(result[0]?.bal) || 0;
  }

  /**
   * Calculate interest for a specific member — dispatches to FD/RD/SB-specific logic
   */
  private async calculateMemberInterest(
    member: MemberMaster,
    fromDate: Date,
    toDate: Date,
    annualRate: number,
    manager: any,
    accountType: string = 'SB',
  ): Promise<InterestCalculationResultDto> {
    if (accountType === 'FD') {
      return this.calculateMemberFDInterest(member, fromDate, toDate, annualRate, manager);
    }
    if (accountType === 'RD') {
      return this.calculateMemberRDInterest(member, fromDate, toDate, annualRate, manager);
    }

    // SB: daily product method (existing logic)
    const openingBalance = await this.getOpeningBalance(member.mbno, fromDate, manager, accountType);

    const transactions = await manager.find(Ledger, {
      where: {
        memberNumber: member.mbno,
        accountType: accountType,
        transactionDate: Between(fromDate, toDate),
      },
      order: {
        transactionDate: 'ASC',
        transactionNumber: 'ASC',
      },
    });

    const dailyBalances = this.calculateDailyBalances(transactions, fromDate, toDate, openingBalance);

    const sumOfBalances = dailyBalances.reduce((sum, day) => sum + day.balance, 0);
    const dayCount = dailyBalances.length;
    const dailyRate = annualRate / 100 / 365;
    // an overdrawn (negative) account never earns negative interest
    const interestAmount = Math.max(0, Math.round(sumOfBalances * dailyRate * 100) / 100);
    const averageBalance = dayCount > 0 ? sumOfBalances / dayCount : 0;

    let totalDebit = 0;
    let totalCredit = 0;
    transactions.forEach(t => {
      if (t.transactionType === 'DR') totalDebit += Number(t.transactionAmount);
      else if (t.transactionType === 'CR') totalCredit += Number(t.transactionAmount);
    });

    const closingBalance = openingBalance + totalCredit - totalDebit + interestAmount;

    return {
      memberNumber: member.mbno,
      memberName: member.fullName,
      accountNumber: member.mbno,
      openingBalance,
      totalDebit,
      totalCredit,
      averageBalance,
      interestAmount,
      closingBalance,
      days: dayCount,
    };
  }

  /**
   * F3: FD Interest — exact legacy formula (Days/Months/Years)
   * Legacy: (P*R*Y)/100 + (P*R*M)/1200 + (P*R*D)/36500
   */
  private async calculateMemberFDInterest(
    member: MemberMaster,
    fromDate: Date,
    toDate: Date,
    annualRate: number,
    manager: any,
  ): Promise<InterestCalculationResultDto> {
    const fdAccounts = await manager.query(
      `SELECT account_number, fdamount, rate, depdate, matdate,
              COALESCE(interestbalance, 0) as interestbalance,
              COALESCE(intpaid, 0) as intpaid
       FROM fdmaster
       WHERE mbno = $1 AND fdrdflag = 'F'
         AND (status = '0' OR status = 'A' OR status IS NULL)`,
      [member.mbno]
    );

    let totalInterest = 0;
    let totalPrincipal = 0;
    // BUG FIX 53: a member with more than one FD account previously had the
    // *combined* interestAmount applied to every one of their fdmaster rows when
    // posting (confirmed live: two real FD accounts with very different principals
    // and rates both ended up with the identical intpaid value after one post).
    // Tracking each account's own net interest here so the caller can update each
    // row with its own share instead of the aggregate.
    const perAccount: { accountNumber: string; netInterest: number }[] = [];

    for (const fd of fdAccounts) {
      const principal = parseFloat(fd.fdamount) || 0;
      const rate = parseFloat(fd.rate) || annualRate;
      const depositDate = new Date(fd.depdate);
      const calcDate = toDate < new Date(fd.matdate || toDate) ? toDate : new Date(fd.matdate);

      const interest = this.calculateFDInterest(principal, rate, depositDate, calcDate);
      const alreadyPaid = parseFloat(fd.intpaid) || 0;
      const netInterest = Math.round(Math.max(interest - alreadyPaid, 0) * 100) / 100;

      perAccount.push({ accountNumber: fd.account_number, netInterest });
      totalInterest += netInterest;
      totalPrincipal += principal;
    }

    totalInterest = Math.round(totalInterest * 100) / 100;

    return {
      memberNumber: member.mbno,
      memberName: member.fullName,
      accountNumber: fdAccounts[0]?.account_number || member.mbno,
      openingBalance: totalPrincipal,
      totalDebit: 0,
      totalCredit: 0,
      averageBalance: totalPrincipal,
      interestAmount: totalInterest,
      closingBalance: totalPrincipal + totalInterest,
      days: Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)),
      fdAccountBreakdown: perAccount,
    } as InterestCalculationResultDto & { fdAccountBreakdown: typeof perAccount };
  }

  /**
   * FD interest exact formula matching legacy stored procedure
   */
  private calculateFDInterest(principal: number, annualRate: number, depositDate: Date, calcDate: Date): number {
    let totalDays = Math.ceil((calcDate.getTime() - depositDate.getTime()) / (1000 * 60 * 60 * 24));
    if (totalDays <= 0) return 0;

    const years = Math.floor(totalDays / 365);
    let remaining = totalDays - (years * 365);
    const months = Math.floor(remaining / 30);
    const days = remaining - (months * 30);

    const yearInterest = (principal * annualRate * years) / 100;
    const monthInterest = (principal * annualRate * months) / 1200;
    const dayInterest = (principal * annualRate * days) / 36500;

    return Math.round((yearInterest + monthInterest + dayInterest) * 100) / 100;
  }

  /**
   * F4: RD Interest — product-based calculation matching legacy Pr_RDInterestCalculation
   * Builds running balance from ledger, calculates balance×days products
   */
  private async calculateMemberRDInterest(
    member: MemberMaster,
    fromDate: Date,
    toDate: Date,
    annualRate: number,
    manager: any,
  ): Promise<InterestCalculationResultDto> {
    // BUG FIX 53: this filtered `headtype = 'RD' OR headtype LIKE 'RD%'` — headmaster
    // has no 'RD'-prefixed headtype at all (confirmed live; the real 9 headtypes are
    // ALN, BANK, CD, CINH, MD, MD1, OTH, RLN, SHR), so this always returned zero rows
    // and RD interest was silently ₹0 for every run. RD principal recovery is posted
    // under headtype 'CD' / code L1004 (same head as CD — confirmed this session in
    // ledger-posting.service.ts's bulk recovery, which posts rd_amount to L1004), so
    // that's the real code RD ledger transactions actually carry.
    const rdHeads = await manager.query(
      `SELECT code FROM headmaster WHERE headtype = 'CD'`
    );
    const rdCodes = rdHeads.map((h: any) => h.code.trim());

    if (rdCodes.length === 0) {
      return {
        memberNumber: member.mbno, memberName: member.fullName, accountNumber: member.mbno,
        openingBalance: 0, totalDebit: 0, totalCredit: 0, averageBalance: 0,
        interestAmount: 0, closingBalance: 0, days: 0,
      };
    }

    // Opening balance: all RD transactions before fromDate
    const opResult = await manager.query(`
      SELECT COALESCE(SUM(CASE WHEN trans_type='CR' THEN trans_amt::numeric ELSE -trans_amt::numeric END), 0) as bal
      FROM ledger WHERE mbno = $1 AND code = ANY($2) AND trans_date::date < $3::date
    `, [member.mbno, rdCodes, fromDate]);
    const openingBalance = parseFloat(opResult[0]?.bal) || 0;

    // Period transactions sorted by date
    const txns = await manager.query(`
      SELECT trans_date, trans_type, trans_amt::numeric as amt
      FROM ledger WHERE mbno = $1 AND code = ANY($2)
        AND trans_date::date >= $3::date AND trans_date::date <= $4::date
      ORDER BY trans_date, ledgerid
    `, [member.mbno, rdCodes, fromDate, toDate]);

    // Build product-based interest: sum of (balance × days at that balance level)
    let runningBalance = openingBalance;
    let totalProduct = 0;
    let lastDate = new Date(fromDate);
    let totalDebit = 0;
    let totalCredit = 0;

    for (const txn of txns) {
      const txnDate = new Date(txn.trans_date);
      const daysBetween = Math.max(Math.ceil((txnDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)), 0);
      totalProduct += runningBalance * daysBetween;

      const amt = parseFloat(txn.amt) || 0;
      if (txn.trans_type === 'CR') {
        runningBalance += amt;
        totalCredit += amt;
      } else {
        runningBalance -= amt;
        totalDebit += amt;
      }
      lastDate = txnDate;
    }

    // Remaining days after last transaction
    const remainingDays = Math.max(Math.ceil((toDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)), 0);
    totalProduct += runningBalance * remainingDays;

    const totalDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
    const interestAmount = Math.round((totalProduct * annualRate / 36500) * 100) / 100;
    const averageBalance = totalDays > 0 ? totalProduct / totalDays : 0;

    return {
      memberNumber: member.mbno,
      memberName: member.fullName,
      accountNumber: member.mbno,
      openingBalance,
      totalDebit,
      totalCredit,
      averageBalance,
      interestAmount,
      closingBalance: runningBalance + interestAmount,
      days: totalDays,
    };
  }

  /**
   * Calculate daily balances for the period
   */
  private calculateDailyBalances(transactions: Ledger[], fromDate: Date, toDate: Date, startBalance: number) {
    const dailyBalances = [];
    let currentBalance = startBalance;

    const currentDate = new Date(fromDate);
    let transactionIndex = 0;

    while (currentDate <= toDate) {
      // Process all transactions for this date
      while (transactionIndex < transactions.length) {
        const transaction = transactions[transactionIndex];
        const transDate = new Date(transaction.transactionDate);

        // Compare dates without time
        if (transDate.toLocaleDateString() === currentDate.toLocaleDateString()) {
          const amount = Number(transaction.transactionAmount);
          if (transaction.transactionType === 'CR') {
            currentBalance += amount;
          } else if (transaction.transactionType === 'DR') {
            currentBalance -= amount;
          }
          transactionIndex++;
        } else if (transDate > currentDate) {
          break;
        } else {
          // Transaction date is before current date (shouldn't happen with sorted query but good to handle)
          transactionIndex++;
        }
      }

      dailyBalances.push({
        date: new Date(currentDate),
        balance: currentBalance,
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return dailyBalances;
  }

  /**
   * Create ledger entry for interest credit
   */
  private async createInterestLedgerEntry(
    member: MemberMaster,
    calculation: InterestCalculationResultDto,
    voucherNumber: string,
    narration: string,
    manager: any,
    accountHead: string,
    accountType: string = 'SB',
    expenseHeadCode?: string,
    /** ES-457: the period's last day - the legacy dates its interest journals at the period end, not at the run time */
    postingDate: Date = new Date(),
  ) {
    const transactionNumber = await this.generateTransactionNumber(manager);
    // BUG FIX 53: ledgerid is required (see entity fix) — generate it the same way
    // as trans_no, under the same lock scope.
    const ledgerId = await this.getNextId(manager, 'ledger', 'ledgerid');

    // CR member's account — interest credited increases the member's balance.
    // BUG FIX 53: accountType was hardcoded 'SB' here regardless of what was actually
    // being processed — an RD or FD interest run silently wrote its ledger legs as if
    // they were SB transactions.
    await manager.save(Ledger, {
      transactionNumber,
      ledgerId,
      transactionDate: postingDate,
      transactionType: 'CR',
      code: accountHead,
      memberNumber: member.mbno,
      accountNumber: calculation.accountNumber,
      accountType,
      transactionAmount: calculation.interestAmount,
      receiptVoucherNumber: voucherNumber,
      voucherType: 'IN',
      modeOfPayment: 'T',
      balance: calculation.closingBalance,
      narration,
      username: 'SYSTEM',
    });

    // DR Interest Expense head — balancing debit records the cost to the society.
    // BUG FIX 53: this used to look up busrules.sbinthead/rdinthead/fdinthead —
    // confirmed live that none of these columns exist in busrules at all (dumped
    // all 59 real columns), so this was a hard SQL error ("column does not exist"),
    // not just a bad fallback — every posting attempt would crash here. There's also
    // no real "interest expense on savings" head anywhere in headmaster to point at
    // instead (checked; the only close name match, E1027, is for security deposits,
    // unrelated) — same class of genuinely-missing-GL-head gap as SB's A001/FD's
    // liability head elsewhere this session. Made it caller-configurable via the DTO
    // instead of querying a nonexistent column, so a real code can be supplied once
    // decided without another code change; L1028 kept only as an already-flagged
    // (confirmed wrong: "G.S.L.I PAYABLE") placeholder default.
    const debitTransNo = await this.generateTransactionNumber(manager);
    const debitLedgerId = await this.getNextId(manager, 'ledger', 'ledgerid');
    const intExpenseCode = expenseHeadCode || 'L1028';
    await manager.save(Ledger, {
      transactionNumber: debitTransNo,
      ledgerId: debitLedgerId,
      transactionDate: postingDate,
      transactionType: 'DR',
      code: intExpenseCode,
      // ES-457: a head-only leg, as the legacy interest journals (E1026: member 0, type OTH) and this app's other
      // postings (income and cash legs) have it. Tagged with the member's number and type SB it was counted in the
      // member's savings balance, so the credited interest was netted away again by every later period and report.
      memberNumber: 0,
      accountNumber: 0,
      accountType: 'OTH',
      transactionAmount: calculation.interestAmount,
      receiptVoucherNumber: voucherNumber,
      voucherType: 'IN',
      modeOfPayment: 'T',
      balance: 0,
      narration: `Interest expense - ${narration}`,
      username: 'SYSTEM',
    });
  }

  /**
   * ES-457: the code of the head the interest on savings is debited to, created in the head master when it is not
   * there yet (expense head under E1000, next free E code). Found by name, so a re-load of the head master from the
   * legacy cannot leave the posting pointing at a code that now means something else. Runs inside the posting
   * transaction under its own advisory lock, so two runs cannot both create it.
   */
  private async ensureSavingsInterestExpenseHead(manager: any): Promise<string> {
    const found = await manager.query(`SELECT code FROM headmaster WHERE head_name = $1 LIMIT 1`, [SB_INTEREST_EXPENSE_HEAD_NAME]);
    if (found.length > 0) return String(found[0].code);
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('headmaster_new_code'))`);
    const again = await manager.query(`SELECT code FROM headmaster WHERE head_name = $1 LIMIT 1`, [SB_INTEREST_EXPENSE_HEAD_NAME]);
    if (again.length > 0) return String(again[0].code);
    const next = await manager.query(
      `SELECT COALESCE(MAX(SUBSTRING(code FROM 2)::int), 1000) + 1 AS n FROM headmaster WHERE pflag = 'E' AND code ~ '^E[0-9]+$'`,
    );
    const code = `E${next[0].n}`;
    await manager.query(
      `INSERT INTO headmaster (code, parent_code, hposition, head_name, interest, headtype, op_bal, pflag)
       VALUES ($1, 'E1000', '', $2, 'N', 'OTH', 0, 'E')`,
      [code, SB_INTEREST_EXPENSE_HEAD_NAME],
    );
    this.logger.log(`Created expense head ${code} ${SB_INTEREST_EXPENSE_HEAD_NAME}`);
    return code;
  }

  // BUG FIX 53: replaces both generateVoucherNumber() and generateTransactionNumber()
  // below, and is also used to generate interestmaster.id, interestpaid.rowid, and
  // ledger.ledgerid — none of which have a real DB sequence/default (confirmed via
  // information_schema). Same transaction-scoped advisory-lock MAX()+1 pattern used
  // throughout the rest of this codebase (e.g. compulsory-deposit.service.ts's
  // getNextId) to serialize concurrent callers without needing new sequence objects.
  private async getNextId(manager: any, table: string, col: string): Promise<number> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}.${col}`]);
    if (table === 'ledger') await lockLedgerIds(manager); // ES-445: the one shared ledger id lock
    const res = await manager.query(`SELECT COALESCE(MAX(${col}), 0) + 1 as next_id FROM ${table}`);
    return parseInt(res[0].next_id);
  }

  /**
   * Generate unique transaction number for the ledger.
   * BUG FIX 53: this used to run `SELECT MAX(trans_no::BIGINT)... FOR UPDATE` — Postgres
   * rejects FOR UPDATE combined with an aggregate function outright (confirmed live:
   * every call threw). Also used this.ledgerRepository outside the active transaction,
   * letting concurrent runs see the same MAX. Now uses the shared advisory-lock pattern.
   */
  private async generateTransactionNumber(manager?: any): Promise<string> {
    const mgr = manager || this.dataSource.manager;
    const next = await this.getNextId(mgr, 'ledger', 'trans_no');
    return String(next);
  }

  /**
   * Get interest calculation history
   */
  async getInterestHistory(): Promise<InterestHistoryDto[]> {
    const history = await this.interestMasterRepository
      .createQueryBuilder('im')
      .leftJoin('im.interestPaidRecords', 'ip')
      .select([
        'im.id',
        'im.intType',
        'im.fromDate',
        'im.toDate',
        'im.rate',
        'COUNT(ip.mbno) as memberCount',
        'SUM(ip.interest) as totalAmount',
      ])
      .groupBy('im.id, im.intType, im.fromDate, im.toDate, im.rate')
      .orderBy('im.fromDate', 'DESC')
      .getRawMany();

    return history.map(item => ({
      id: item.im_id,
      intType: item.im_intType,
      fromDate: item.im_fromDate,
      toDate: item.im_toDate,
      rate: parseFloat(item.im_rate),
      totalAmount: parseFloat(item.totalAmount) || 0,
      memberCount: parseInt(item.memberCount) || 0,
    }));
  }

  /**
   * Get current interest rate for savings accounts
   */
  async getCurrentInterestRate(): Promise<number> {
    const currentRate = await this.interestMasterRepository.findOne({
      where: {
        intType: 'SB',
      },
      order: {
        id: 'DESC',
      },
    });

    return currentRate ? currentRate.rate : 4.0; // Default 4% if no rate found
  }

  /**
   * Get interest calculation preview without saving
   */
  async previewInterestCalculation(dto: UpdateSavingInterestDto): Promise<InterestRunSummaryDto> {
    const fromDate = new Date(dto.fromDate);
    const toDate = new Date(dto.toDate);

    if (fromDate >= toDate) {
      throw new BadRequestException('From date must be before to date');
    }

    const accountTypeCode = dto.accountType || 'SB';
    assertNotRdCd(accountTypeCode);
    const allMembers = await this.getEligibleMembers();
    let eligibleMembers = dto.memberNo
      ? allMembers.filter(m => m.mbno === dto.memberNo)
      : allMembers;
    // ES-510: a member with no ledger row of this account type up to the period end has no balance and no movement,
    // so the calculation can only give 0 interest and the member is left out of the result anyway. Before, the daily
    // calculation ran for every active member (two queries each) even when only a few held the account. FD and RD
    // read their own tables, so they keep the full list.
    if (accountTypeCode !== 'FD' && accountTypeCode !== 'RD' && eligibleMembers.length > 0) {
      const holders: Array<{ mbno: string }> = await this.dataSource.query(
        `SELECT DISTINCT mbno FROM ledger WHERE acc_type = $1 AND trans_date <= $2`,
        [accountTypeCode, toDate],
      );
      const holderSet = new Set(holders.map(h => String(h.mbno)));
      eligibleMembers = eligibleMembers.filter(m => holderSet.has(String(m.mbno)));
    }
    const memberCalculations: InterestCalculationResultDto[] = [];
    let totalInterestAmount = 0;

    // Calculate interest for each member
    for (const member of eligibleMembers) {
      try {
        const calculation = await this.calculateMemberInterest(
          member,
          fromDate,
          toDate,
          dto.interestRate,
          this.dataSource.manager,
          accountTypeCode,
        );

        if (calculation.interestAmount > 0) {
          memberCalculations.push(calculation);
          totalInterestAmount += calculation.interestAmount;
        }
      } catch (error) {
        this.logger.error(`Error in preview calculation for member ${member.mbno}:`, error);
      }
    }

    return {
      totalMembers: memberCalculations.length,
      totalInterestAmount,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      interestRate: dto.interestRate,
      voucherNumber: dto.voucherNumber || 'PREVIEW',
      calculationDate: new Date().toISOString(),
      memberCalculations,
    };
  }

  /**
   * Validate interest calculation parameters
   */
  async validateInterestParameters(dto: UpdateSavingInterestDto): Promise<{
    valid: boolean;
    message: string;
    eligibleMembers?: number;
  }> {
    try {
      const problem = interestParameterProblem(dto);
      if (problem) return { valid: false, message: problem };
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);

      // Check for existing calculation
      const existingRun = await this.interestMasterRepository.findOne({
        where: {
          fromDate: fromDate,
          toDate: toDate,
          intType: dto.accountType || 'SB',
        },
      });

      if (existingRun) {
        return { valid: false, message: 'Interest has already been calculated for this period' };
      }

      // Get eligible members count
      const eligibleMembers = await this.getEligibleMembers();

      return {
        valid: true,
        message: 'Parameters are valid',
        eligibleMembers: eligibleMembers.length,
      };

    } catch (error) {
      return { valid: false, message: 'Validation failed: ' + error.message };
    }
  }

  /**
   * Yearly Fund Process (year end). The legacy posted, once a year per member: DR E1026 / CR L1004 (interest on compulsory
   * deposit), DR L1024 / CR L1004 (dividend) and DR L1004 / CR L1003 (group insurance). This window used to credit CASH IN
   * HAND (A1001) with an interest worked out from the monthly-deposit fields and to post the insurance to a placeholder head
   * (L4001); both are gone (ES-583). Now:
   *   - the RD/CD interest is worked out and posted by the RD/CD engine (RD/CD Financial Year Closing) for every member, the
   *     legacy way (DR E1026 / CR L1004 per member, dated the year end);
   *   - the group insurance is deducted by the Group Insurance window (one run per year, DR L1004 / CR L1003), not here;
   *   - the dividend is worked out only by the Dividend Calculation window (ES-599); this window just reports whether it
   *     has been calculated for the year.
   */
  async processYearlyFundProcess(dto: UpdateSavingInterestDto, isPreview: boolean = false, username: string = 'SYSTEM'): Promise<InterestRunSummaryDto> {
    if (!this.rdClosing) throw new BadRequestException('The RD/CD year-end engine is not available.');
    const toDate = new Date(dto.toDate);
    if (Number.isNaN(toDate.getTime())) throw new BadRequestException('A valid financial year end date is needed.');
    const toYmd = `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, '0')}-${String(toDate.getDate()).padStart(2, '0')}`;
    const fy = await this.dataSource.query(
      `SELECT yearcode, to_char((start_date + interval '12 hours')::date, 'YYYY-MM-DD') AS s FROM yearend WHERE $1::date BETWEEN (start_date + interval '12 hours')::date AND (end_date + interval '12 hours')::date LIMIT 1`,
      [toYmd],
    );
    if (!fy?.[0]) throw new BadRequestException(`No financial year contains ${toYmd}.`);
    const yearcode = Number(fy[0].yearcode);
    const startYear = Number(String(fy[0].s).slice(0, 4)); // a dividend is stored under the year its financial year starts in
    const calculationDate = new Date().toISOString();

    // 1. the dividend (ES-599): this window no longer declares it. The Dividend Calculation window is the one place
    // that works it out (Total Product x rate / 1200, stored under the year the financial year STARTS), so there is
    // one formula and one year convention, and the year-end run can never stop because dividend rows already exist.
    // It only says whether the year's dividend has been calculated yet.
    let dividendNote = '';
    if (!isPreview) {
      const rules = await this.systemConfigService.getBusinessRules();
      if (Number(rules['RULE_DIVIDEND_PCT'] || 0) > 0) {
        const calculated = await this.dataSource.query(`SELECT 1 FROM dividend_master WHERE year = $1 LIMIT 1`, [startYear]);
        dividendNote = calculated.length > 0
          ? `Dividend ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')} already calculated`
          : `Dividend ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')} NOT calculated yet: use Dividend Calculation`;
      }
    }

    // 2. the RD/CD interest, by the RD/CD engine
    let nameRows: any[] = [];
    try { nameRows = await this.dataSource.query(`SELECT mbno::bigint::text AS m, COALESCE(full_name, '') AS n FROM member_master`); } catch { nameRows = []; }
    const names = new Map<string, string>(nameRows.map((r: any) => [r.m, r.n]));
    const memberCalculations: InterestCalculationResultDto[] = [];
    let total = 0;
    let voucherNumber = isPreview ? 'PREVIEW' : 'PER MEMBER';
    let failedNote = '';
    let insuranceNote = '';
    if (isPreview) {
      for (let offset = 0; ; offset += 200) {
        const page = await this.rdClosing.previewFinancialYearClosing(yearcode, 200, offset);
        for (const p of page.members) {
          const interest = Number(p.totalInterestIfClosedNow || 0);
          memberCalculations.push({
            memberNumber: p.mbno, memberName: names.get(p.mbno) ?? '', accountNumber: p.mbno, openingBalance: Number(p.currentBalance || 0),
            totalDebit: 0, totalCredit: interest, averageBalance: 0, interestAmount: interest, closingBalance: Number(p.currentBalance || 0) + interest, days: 365,
          });
          total += interest;
        }
        if (offset + 200 >= page.total) break;
      }
    } else {
      const res = await this.rdClosing.closeFinancialYear(yearcode, username);
      for (const r of res.succeeded) {
        const interest = Number(r.totalInterestCredited || 0);
        memberCalculations.push({
          memberNumber: r.mbno, memberName: names.get(r.mbno) ?? '', accountNumber: r.mbno, openingBalance: Number(r.openingBalance || 0),
          totalDebit: 0, totalCredit: interest, averageBalance: 0, interestAmount: interest, closingBalance: Number(r.closingBalance || 0), days: 365,
        });
        total += interest;
      }
      if (res.failed.length > 0) {
        failedNote = `${res.failed.length} member(s) could not be closed (already closed or an error): ${res.failed.slice(0, 5).map((f) => `${f.mbno}: ${f.error}`).join('; ')}`;
        this.logger.warn(`Yearly Fund Process: ${failedNote}`);
      }
    }

    // 3. the group insurance (optional): the Group Insurance run of the year (DR L1004 / CR L1003 per member), after the interest
    const lumpSum = Number(dto.insuranceLumpSum || 0);
    if (lumpSum > 0) {
      if (!this.groupInsurance) throw new BadRequestException('Group insurance is not available.');
      try {
        if (isPreview) {
          const gi = await this.groupInsurance.preview({ yearcode, lumpSum, limit: 1 });
          insuranceNote = `Group insurance: ${gi.summary.membersCharged} members, ${gi.summary.totalToCollect} to collect${gi.alreadyPosted ? ' (ALREADY POSTED for this year)' : ''}`;
        } else {
          const gi = await this.groupInsurance.post({ yearcode, lumpSum }, username);
          insuranceNote = `Group insurance posted: ${gi.membersCharged} members, ${gi.totalCharged}, voucher ${gi.voucherNo}`;
        }
      } catch (e: any) {
        insuranceNote = `Group insurance NOT posted: ${e?.message || e}`;
        this.logger.warn(`Yearly Fund Process: ${insuranceNote}`);
      }
    }

    return {
      totalMembers: memberCalculations.length,
      totalInterestAmount: Math.round(total * 100) / 100,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      interestRate: 0,
      voucherNumber: [voucherNumber, failedNote, insuranceNote, dividendNote].filter(Boolean).join(' - '),
      calculationDate,
      memberCalculations,
    };
  }
}
