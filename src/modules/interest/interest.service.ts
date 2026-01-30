import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
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
      const existingRun = await this.interestMasterRepository.findOne({
        where: {
          fromDate: fromDate,
          toDate: toDate,
          intType: 'SB', // Savings Bank
        },
      });

      if (existingRun) {
        throw new BadRequestException('Interest has already been calculated for this period or dates overlap with existing records');
      }

      // Get all eligible members (active members)
      const eligibleMembers = await this.getEligibleMembers();
      this.logger.log(`Found ${eligibleMembers.length} eligible members`);

      // Generate voucher number if not provided
      const voucherNumber = dto.voucherNumber || await this.generateVoucherNumber();

      // Create interest master record
      const interestMaster = await queryRunner.manager.save(InterestMaster, {
        intType: 'SB',
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

            // Create ledger entry for interest credit
            await this.createInterestLedgerEntry(
              member,
              calculation,
              voucherNumber,
              dto.narration || `Interest credited for period ${dto.fromDate} to ${dto.toDate}`,
              queryRunner.manager,
              dto.accountHead || 'A1001'
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
    const transactionNumber = await this.generateTransactionNumber();

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
  }

  /**
   * Generate unique voucher number
   */
  private async generateVoucherNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const lastVoucher = await this.interestPaidRepository
      .createQueryBuilder('ip')
      .where('ip.voucherNumber LIKE :pattern', { pattern: `INT${year}%` })
      .orderBy('ip.voucherNumber', 'DESC')
      .getOne();

    let sequence = 1;
    if (lastVoucher && lastVoucher.voucherNumber) {
      const lastSequence = parseInt(lastVoucher.voucherNumber.slice(-3));
      sequence = isNaN(lastSequence) ? 1 : lastSequence + 1;
    }

    return `INT${year}${sequence.toString().padStart(3, '0')}`;
  }

  /**
   * Generate unique transaction number
   */
  private async generateTransactionNumber(): Promise<string> {
    const lastTransaction = await this.ledgerRepository
      .createQueryBuilder('l')
      .orderBy('l.transactionNumber', 'DESC')
      .getOne();

    let nextNumber = 1;
    if (lastTransaction && lastTransaction.transactionNumber) {
      nextNumber = parseInt(lastTransaction.transactionNumber) + 1;
    }

    return nextNumber.toString();
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

    const eligibleMembers = await this.getEligibleMembers();
    const memberCalculations: InterestCalculationResultDto[] = [];
    let totalInterestAmount = 0;

    // Calculate interest for each member (preview only)
    for (const member of eligibleMembers.slice(0, 10)) { // Limit to first 10 for preview
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
}