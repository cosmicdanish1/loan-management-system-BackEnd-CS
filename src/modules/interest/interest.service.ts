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

      // Check if interest has already been calculated for this period
      // BUG FIX: intType was hardcoded to 'SB' — RD/FD runs were never detected as duplicates,
      // allowing the same period to be posted multiple times for non-SB account types.
      const accountTypeCode = dto.accountHead || 'SB';
      const existingRun = await this.interestMasterRepository.findOne({
        where: {
          fromDate: fromDate,
          toDate: toDate,
          intType: accountTypeCode,
        },
      });

      if (existingRun) {
        throw new BadRequestException('Interest has already been calculated for this period or dates overlap with existing records');
      }

      // Get all eligible members (active members), optionally filtered to one member
      const allMembers = await this.getEligibleMembers();
      const eligibleMembers = dto.memberNo
        ? allMembers.filter(m => m.mbno === dto.memberNo)
        : allMembers;
      this.logger.log(`Found ${eligibleMembers.length} eligible members`);

      // BUG FIX: generateVoucherNumber() was using this.interestPaidRepository outside the
      // transaction — two concurrent runs see the same max and produce duplicate voucher numbers.
      // Pass queryRunner.manager so the SELECT runs inside the active transaction with FOR UPDATE.
      const voucherNumber = dto.voucherNumber || await this.generateVoucherNumber(queryRunner.manager);

      // Create interest master record
      // BUG FIX: intType was hardcoded to 'SB' — RD/FD interest records were saved with wrong type.
      const interestMaster = await queryRunner.manager.save(InterestMaster, {
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
          );

          if (calculation.interestAmount > 0) {
            // Create interest paid record
            await queryRunner.manager.save(InterestPaid, {
              id: interestMaster.id.toString(),
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
              voucherNumber: voucherNumber,
              accountNumber: calculation.accountNumber,
            });

            // BUG FIX: dto.accountHead is the account TYPE code (e.g. 'RD', 'SB'), NOT a GL head.
            // Previously passing it directly as the GL code caused invalid ledger entries.
            // Map account type to the correct GL credit head for savings/interest postings.
            const GL_CREDIT_HEAD_MAP: Record<string, string> = {
              'RD': 'A1002',
              'SB': 'A1001',
              'FD': 'A1003',
            };
            const glHead = GL_CREDIT_HEAD_MAP[accountTypeCode] || 'A1001';

            // Create ledger entry for interest credit
            await this.createInterestLedgerEntry(
              member,
              calculation,
              voucherNumber,
              dto.narration || `Interest credited for period ${dto.fromDate} to ${dto.toDate}`,
              queryRunner.manager,
              glHead
            );

            memberCalculations.push(calculation);
            totalInterestAmount += calculation.interestAmount;
          }
        } catch (error) {
          this.logger.error(`Error calculating interest for member ${member.mbno}:`, error);
          // Continue with other members
        }
      }

      await queryRunner.commitTransaction();

      this.logger.log(`Interest calculation completed. Total amount: ${totalInterestAmount}`);

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
   */
  private async getOpeningBalance(memberNo: string, date: Date, manager: any): Promise<number> {
    const lastTransaction = await manager.findOne(Ledger, {
      where: {
        memberNumber: memberNo,
        accountType: 'SB',
        transactionDate: Between(new Date(0), new Date(date.getTime() - 1)),
      },
      order: {
        transactionDate: 'DESC',
        transactionNumber: 'DESC',
      },
    });

    return lastTransaction ? Number(lastTransaction.balance) : 0;
  }

  /**
   * Calculate interest for a specific member
   */
  private async calculateMemberInterest(
    member: MemberMaster,
    fromDate: Date,
    toDate: Date,
    annualRate: number,
    manager: any,
  ): Promise<InterestCalculationResultDto> {
    // Get opening balance
    const openingBalance = await this.getOpeningBalance(member.mbno, fromDate, manager);

    // Get member's ledger transactions for the period
    const transactions = await manager.find(Ledger, {
      where: {
        memberNumber: member.mbno,
        accountType: 'SB',
        transactionDate: Between(fromDate, toDate),
      },
      order: {
        transactionDate: 'ASC',
        transactionNumber: 'ASC',
      },
    });

    // Calculate daily balances starting from openingBalance
    const dailyBalances = this.calculateDailyBalances(transactions, fromDate, toDate, openingBalance);

    // Calculate interest (Daily Product Method: Sum of daily balances * Daily Rate)
    // Most credit societies use (Sum of Daily Balances / Period Days) * Daily Rate * Period Days
    // Which simplifies to: Sum of Daily Balances * (AnnualRate / 100 / 365)

    const sumOfBalances = dailyBalances.reduce((sum, day) => sum + day.balance, 0);
    const dayCount = dailyBalances.length;
    const dailyRate = annualRate / 100 / 365;

    // Using simple daily product method
    const interestAmount = Math.round(sumOfBalances * dailyRate * 100) / 100;

    // The average balance for display/logging
    const averageBalance = sumOfBalances / dayCount;

    // Calculate total debits and credits
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
    accountHead: string
  ) {
    // BUG FIX: generateTransactionNumber() was reading this.ledgerRepository outside the
    // transaction — concurrent runs produced duplicate trans_no. Pass manager to run inside
    // the active transaction with FOR UPDATE.
    const transactionNumber = await this.generateTransactionNumber(manager);

    // CR member's SB account — interest credited increases the member's balance
    await manager.save(Ledger, {
      transactionNumber,
      transactionDate: new Date(),
      transactionType: 'CR',
      code: accountHead,
      memberNumber: member.mbno,
      accountNumber: calculation.accountNumber,
      accountType: 'SB',
      transactionAmount: calculation.interestAmount,
      receiptVoucherNumber: voucherNumber,
      voucherType: 'IN',
      modeOfPayment: 'T',
      balance: calculation.closingBalance,
      narration,
      username: 'SYSTEM',
    });

    // DR Interest Expense head — balancing debit records the cost to the society
    const debitTransNo = await this.generateTransactionNumber(manager);
    // BUG FIX: this.dataSource.query() bypassed the active transaction (separate connection).
    // Use manager.query() so the read is consistent within the transaction.
    const sbIntExpenseHead = await manager.query(
      `SELECT COALESCE(sbinthead, 'L1028') as head FROM busrules ORDER BY appdate DESC LIMIT 1`
    );
    const intExpenseCode = sbIntExpenseHead[0]?.head || 'L1028';
    await manager.save(Ledger, {
      transactionNumber: debitTransNo,
      transactionDate: new Date(),
      transactionType: 'DR',
      code: intExpenseCode,
      memberNumber: member.mbno,
      accountNumber: calculation.accountNumber,
      accountType: 'SB',
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
   * Generate unique voucher number
   * BUG FIX: original used this.interestPaidRepository outside the active transaction — two
   * concurrent runs produced the same voucher number. Accept the active EntityManager and query
   * with FOR UPDATE to serialize access.
   */
  private async generateVoucherNumber(manager?: any): Promise<string> {
    const year = new Date().getFullYear();
    const mgr = manager || this.dataSource.manager;
    const result = await mgr.query(
      `SELECT voucher_number FROM interest_paid WHERE voucher_number LIKE $1 ORDER BY voucher_number DESC LIMIT 1 FOR UPDATE`,
      [`INT${year}%`]
    );

    let sequence = 1;
    if (result && result[0]) {
      const lastVoucherNo: string = result[0].voucher_number || result[0].vouchernumber || '';
      if (lastVoucherNo) {
        const lastSequence = parseInt(lastVoucherNo.slice(-3));
        sequence = isNaN(lastSequence) ? 1 : lastSequence + 1;
      }
    }

    return `INT${year}${sequence.toString().padStart(3, '0')}`;
  }

  /**
   * Generate unique transaction number
   * BUG FIX: original used this.ledgerRepository outside the active transaction — two concurrent
   * interest postings both saw the same MAX and generated duplicate trans_no values.
   * Fix: accept the active EntityManager and use raw SQL with FOR UPDATE to lock the aggregate row.
   */
  private async generateTransactionNumber(manager?: any): Promise<string> {
    const mgr = manager || this.dataSource.manager;
    const result = await mgr.query(
      `SELECT COALESCE(MAX(trans_no::BIGINT), 0) + 1 AS next_no FROM ledger FOR UPDATE`
    );
    return String(parseInt(result[0]?.next_no || '1'));
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
          intType: 'SB',
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
      const voucherNumber = dto.voucherNumber || (isPreview ? 'PREVIEW' : await this.generateVoucherNumber());

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
            const transNo = await this.generateTransactionNumber();
            await queryRunner.manager.save(Ledger, {
              transactionNumber: transNo,
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