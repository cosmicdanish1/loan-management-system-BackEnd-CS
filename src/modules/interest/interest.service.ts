import { Injectable, Logger, BadRequestException, NotFoundException, Inject, forwardRef } from '@nestjs/common';
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

@Injectable()
export class InterestService {
  private readonly logger = new Logger(InterestService.name);

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

      // Validate dates
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);

      if (fromDate >= toDate) {
        throw new BadRequestException('From date must be before to date');
      }

      // BUG FIX 53: this was an exact 3-column match (fromDate, toDate, intType),
      // despite the error message claiming "or dates overlap" — Jan 1-31 then
      // Jan 1-Feb 28 would both post, double-crediting the overlapping days. Now a
      // real overlap check: any existing run of the same type whose range intersects
      // the requested one blocks it.
      const accountTypeCode = dto.accountType || 'SB';
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
            const GL_CREDIT_HEAD_MAP: Record<string, string> = {
              'RD': 'A1002',
              'SB': 'A1001',
              'FD': 'A1003',
            };
            const glHead = dto.accountHead || GL_CREDIT_HEAD_MAP[accountTypeCode] || 'A1001';

            await this.createInterestLedgerEntry(
              member,
              calculation,
              voucherNumber,
              dto.narration || `Interest credited for period ${dto.fromDate} to ${dto.toDate}`,
              queryRunner.manager,
              glHead,
              accountTypeCode,
              dto.expenseHeadCode,
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

            memberCalculations.push(calculation);
            totalInterestAmount += calculation.interestAmount;
          }
        } catch (error) {
          this.logger.error(`Error calculating interest for member ${member.mbno}:`, error);
        }
      }

      // BUG FIX 53: this built its own CR/DR pairs from each calculation's own
      // interestAmount (`[{CR, amount}, {DR, amount}]` from the same number) — that's
      // mathematically incapable of ever failing, regardless of what was actually
      // written to the ledger. Reading back the real rows just inserted (by
      // voucherNumber, within this same transaction) actually verifies something.
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
    const interestAmount = Math.round(sumOfBalances * dailyRate * 100) / 100;
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
      transactionDate: new Date(),
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
      transactionDate: new Date(),
      transactionType: 'DR',
      code: intExpenseCode,
      memberNumber: member.mbno,
      accountNumber: calculation.accountNumber,
      accountType,
      transactionAmount: calculation.interestAmount,
      receiptVoucherNumber: voucherNumber,
      voucherType: 'IN',
      modeOfPayment: 'T',
      balance: 0,
      narration: `Interest expense - ${narration}`,
      username: 'SYSTEM',
    });
  }

  // BUG FIX 53: replaces both generateVoucherNumber() and generateTransactionNumber()
  // below, and is also used to generate interestmaster.id, interestpaid.rowid, and
  // ledger.ledgerid — none of which have a real DB sequence/default (confirmed via
  // information_schema). Same transaction-scoped advisory-lock MAX()+1 pattern used
  // throughout the rest of this codebase (e.g. compulsory-deposit.service.ts's
  // getNextId) to serialize concurrent callers without needing new sequence objects.
  private async getNextId(manager: any, table: string, col: string): Promise<number> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}.${col}`]);
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
    const allMembers = await this.getEligibleMembers();
    const eligibleMembers = dto.memberNo
      ? allMembers.filter(m => m.mbno === dto.memberNo)
      : allMembers;
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
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);

      // Check date validity
      if (fromDate >= toDate) {
        return { valid: false, message: 'From date must be before to date' };
      }

      // Check if period is too long (more than 1 year)
      const daysDiff = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 365) {
        return { valid: false, message: 'Interest period cannot exceed 365 days' };
      }

      // Check if interest rate is reasonable
      if (dto.interestRate < 0 || dto.interestRate > 50) {
        return { valid: false, message: 'Interest rate must be between 0% and 50%' };
      }

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
   * Process Yearly Fund Interest, Dividend, and Insurance
   */
  async processYearlyFundProcess(dto: UpdateSavingInterestDto, isPreview: boolean = false): Promise<InterestRunSummaryDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    if (!isPreview) await queryRunner.startTransaction();

    try {
      this.logger.log(`Starting Yearly Fund Process (Preview: ${isPreview})`);

      // 1. Fetch Business Rules
      const rules = await this.systemConfigService.getBusinessRules();
      const fundIntRate = Number(rules['RULE_FUND_INT_RATE'] || 0);
      const dividendPct = Number(rules['RULE_DIVIDEND_PCT'] || 0);
      const insuranceAmt = Number(rules['RULE_GRP_INSURANCE_AMT'] || 0);

      let interestChart = [];
      try {
        const charStr = rules['RULE_CD_INTEREST_CHART'];
        interestChart = typeof charStr === 'string' ? JSON.parse(charStr) : (charStr || []);
      } catch (e) {
        this.logger.warn('Failed to parse interest chart', e);
      }

      // 2. Fetch Eligible Members with their Funds Data
      const members = await this.memberMasterRepository.find({
        where: { isactive: 'Y' },
        order: { mbno: 'ASC' }
      });

      const memberCalculations: InterestCalculationResultDto[] = [];
      let totalProcessAmount = 0;
      const processDate = new Date();
      const voucherNumber = dto.voucherNumber || (isPreview ? 'PREVIEW' : await generateVoucherNo(queryRunner.manager, 'J'));

      // 3. Iterate and Calculate
      for (const member of members) {
        // Fetch Funds Master for this member
        const funds = await this.fundsRepository.findOne({ where: { memberNo: Number(member.mbno) } });

        if (!funds) continue; // Skip if no funds record found

        // A. Interest on Opening Balance
        // We use monthlyContributionOpeningBalance as the base, assuming it was carried forward
        const openingBalance = Number(funds.monthlyContributionOpeningBalance || 0);
        const interestOnBalance = Math.round(openingBalance * (fundIntRate / 100));

        // B. Interest on Monthly Contribution
        const monthlyContrib = Number(funds.monthlyContributionInstallment || 0);
        let interestOnContrib = 0;

        // Find slab in chart
        // Chart format: [{ monthlyContribution: 200, yearlyInterest: 91.20 }]
        // We look for exact match or closest lower slab? Reqs say "look up this amount". assuming exact or logic.
        // Usually it's exact match for standard slabs.
        const slab = interestChart.find((s: any) => Number(s.monthlyContribution) === monthlyContrib);
        if (slab) {
          interestOnContrib = Number(slab.yearlyInterest);
        } else {
          // Fallback logic? Or 0? Let's assume 0 if not found for now.
          // Or maybe proportional? existing logic suggests chart lookup.
          interestOnContrib = 0;
        }

        // C. Dividend Calculation
        // Use sharesOpeningBalance (assuming it represents the capital held for the year)
        const shareCapital = Number(funds.sharesOpeningBalance || 0);
        const dividendAmount = Math.round(shareCapital * (dividendPct / 100));

        // D. Deductions (Group Insurance)
        const deductionInsurance = insuranceAmt;

        // E. Total Calculation
        const totalCredit = interestOnBalance + interestOnContrib + dividendAmount;
        const totalDebit = deductionInsurance; // + Loan Deductions if any
        const netAdjustment = totalCredit - totalDebit;

        const closingBalance = openingBalance + netAdjustment; // This effectively updates the detailed balance logic

        // 4. Create Records if Not Preview
        if (!isPreview && netAdjustment !== 0) {
          // A. Create Transaction Record (Maybe one consolidated journal or separate?)
          // Usually we post individual components to Ledger

          // 1. Interest Posting (Credit)
          if (interestOnBalance + interestOnContrib > 0) {
            await this.createInterestLedgerEntry(
              member,
              {
                accountNumber: member.mbno,
                interestAmount: interestOnBalance + interestOnContrib,
                closingBalance: 0, // Ledger logic handles balance update 
                // ... other fields mocked for helper
                memberNumber: member.mbno, memberName: member.fullName, openingBalance, totalDebit: 0, totalCredit: 0, averageBalance: 0, days: 365
              },
              voucherNumber,
              `Yearly Fund Interest`,
              queryRunner.manager,
              'A1001' // Savings Head
            );
          }

          // 2. Dividend Posting (Credit)
          if (dividendAmount > 0) {
            await this.createInterestLedgerEntry(
              member,
              {
                accountNumber: member.mbno,
                interestAmount: dividendAmount,
                // ...
                closingBalance: 0, memberNumber: member.mbno, memberName: member.fullName, openingBalance, totalDebit: 0, totalCredit: 0, averageBalance: 0, days: 365
              },
              voucherNumber,
              `Yearly Dividend`,
              queryRunner.manager,
              'A2001' // Share Head? Need to check Chart of Accounts. Using placeholder.
            );
          }

          // 3. Insurance Deduction (Debit)
          if (deductionInsurance > 0) {
            // Determine transaction number
            const transNo = await this.generateTransactionNumber(queryRunner.manager);
            // BUG FIX 53: ledgerid required (see entity fix).
            const insuranceLedgerId = await this.getNextId(queryRunner.manager, 'ledger', 'ledgerid');
            await queryRunner.manager.save(Ledger, {
              transactionNumber: transNo,
              ledgerId: insuranceLedgerId,
              transactionDate: processDate,
              transactionType: 'DR',
              code: 'L4001', // Liability/Expense Head for Insurance? Placeholder.
              memberNumber: member.mbno,
              accountNumber: member.mbno,
              accountType: 'SB', // Deduct from Savings/Fund
              transactionAmount: deductionInsurance,
              receiptVoucherNumber: voucherNumber,
              voucherType: 'JV',
              modeOfPayment: 'T',
              balance: 0, // Recalculated by trigger usually
              narration: 'Annual Group Insurance Deduction',
              username: 'SYSTEM',
            });
          }

          // Update FundsMaster balances if needed?
          // Usually ledger is the source of truth, but FundsMaster has `mdopbal`.
          // We might need to update `mdopbal` for NEXT year? 
          // Or `mdbal` (current balance).
          // Let's assume Ledger is primary.
        }

        // Add to result list
        memberCalculations.push({
          memberNumber: member.mbno,
          memberName: member.fullName,
          accountNumber: member.mbno,
          openingBalance,
          totalDebit,
          totalCredit,
          averageBalance: 0,
          interestAmount: netAdjustment, // Net effect
          closingBalance,
          days: 365
        });

        totalProcessAmount += netAdjustment;
      }

      if (!isPreview) await queryRunner.commitTransaction();

      return {
        totalMembers: memberCalculations.length,
        totalInterestAmount: totalProcessAmount,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        interestRate: 0, // composite
        voucherNumber,
        calculationDate: processDate.toISOString(),
        memberCalculations
      };

    } catch (error) {
      if (!isPreview) await queryRunner.rollbackTransaction();
      this.logger.error('Yearly Fund Process Failed', error);
      throw error;
    } finally {
      // BUG FIX: when isPreview=true, queryRunner.connect() was always called but release() was
      // gated on !isPreview — every preview request permanently leaked a DB connection from the
      // pool. Always release regardless of preview mode.
      await queryRunner.release();
    }
  }
}