import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { LoanPayment } from '../../loan/entities/loan-payment.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { DataConsistencyService, ConsistencyCheckResult } from './data-consistency.service';

export interface CorrectionResult {
  success: boolean;
  message: string;
  correctedRecords: number;
  errors: string[];
  rollbackAvailable: boolean;
}

export interface BulkCorrectionResult {
  totalAttempted: number;
  totalCorrected: number;
  totalFailed: number;
  results: CorrectionResult[];
  summary: string;
}

export interface OrphanedRecordFix {
  recordType: 'loan' | 'deposit' | 'payment' | 'transaction';
  recordId: number;
  action: 'delete' | 'reassign' | 'archive';
  newParentId?: number;
}

export interface BalanceCorrectionRequest {
  accountType: 'loan' | 'deposit';
  accountId: number;
  correctedBalance: number;
  reason: string;
  createAdjustmentEntry: boolean;
}

@Injectable()
export class DataCorrectionService {
  private readonly logger = new Logger(DataCorrectionService.name);

  constructor(
    @InjectRepository(Member)
    private memberRepository: Repository<Member>,
    @InjectRepository(LoanAccount)
    private loanAccountRepository: Repository<LoanAccount>,
    @InjectRepository(LoanPayment)
    private loanPaymentRepository: Repository<LoanPayment>,
    @InjectRepository(FixedDeposit)
    private fixedDepositRepository: Repository<FixedDeposit>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    private dataConsistencyService: DataConsistencyService,
    private dataSource: DataSource,
  ) {}

  /**
   * Auto-fix issues found in consistency checks
   */
  async autoFixConsistencyIssues(): Promise<BulkCorrectionResult> {
    this.logger.log('Starting auto-fix for consistency issues');

    const consistencyReport = await this.dataConsistencyService.runConsistencyChecks();
    const results: CorrectionResult[] = [];

    let totalAttempted = 0;
    let totalCorrected = 0;
    let totalFailed = 0;

    // Process each failed check that has auto-fix available
    for (const check of consistencyReport.checks) {
      if (check.status === 'FAIL' && check.fixAvailable) {
        totalAttempted++;
        
        try {
          const result = await this.fixSpecificIssue(check);
          results.push(result);
          
          if (result.success) {
            totalCorrected++;
          } else {
            totalFailed++;
          }
        } catch (error) {
          totalFailed++;
          results.push({
            success: false,
            message: `Failed to fix ${check.checkName}: ${error.message}`,
            correctedRecords: 0,
            errors: [error.message],
            rollbackAvailable: false,
          });
        }
      }
    }

    const summary = `Auto-fix completed: ${totalCorrected}/${totalAttempted} issues fixed, ${totalFailed} failed`;

    return {
      totalAttempted,
      totalCorrected,
      totalFailed,
      results,
      summary,
    };
  }

  /**
   * Fix orphaned records
   */
  async fixOrphanedRecords(fixes: OrphanedRecordFix[]): Promise<CorrectionResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let correctedRecords = 0;
      const errors: string[] = [];

      for (const fix of fixes) {
        try {
          switch (fix.recordType) {
            case 'loan':
              await this.fixOrphanedLoan(fix, queryRunner);
              break;
            case 'deposit':
              await this.fixOrphanedDeposit(fix, queryRunner);
              break;
            case 'payment':
              await this.fixOrphanedPayment(fix, queryRunner);
              break;
            case 'transaction':
              await this.fixOrphanedTransaction(fix, queryRunner);
              break;
          }
          correctedRecords++;
        } catch (error) {
          errors.push(`${fix.recordType} ${fix.recordId}: ${error.message}`);
        }
      }

      await queryRunner.commitTransaction();

      return {
        success: errors.length === 0,
        message: `Fixed ${correctedRecords} orphaned records`,
        correctedRecords,
        errors,
        rollbackAvailable: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Orphaned records fix failed', error.stack);

      return {
        success: false,
        message: `Orphaned records fix failed: ${error.message}`,
        correctedRecords: 0,
        errors: [error.message],
        rollbackAvailable: false,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Correct balance discrepancies
   */
  async correctBalanceDiscrepancies(
    corrections: BalanceCorrectionRequest[],
  ): Promise<CorrectionResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let correctedRecords = 0;
      const errors: string[] = [];

      for (const correction of corrections) {
        try {
          if (correction.accountType === 'loan') {
            await this.correctLoanBalance(correction, queryRunner);
          } else if (correction.accountType === 'deposit') {
            await this.correctDepositBalance(correction, queryRunner);
          }
          correctedRecords++;
        } catch (error) {
          errors.push(`${correction.accountType} ${correction.accountId}: ${error.message}`);
        }
      }

      await queryRunner.commitTransaction();

      return {
        success: errors.length === 0,
        message: `Corrected ${correctedRecords} balance discrepancies`,
        correctedRecords,
        errors,
        rollbackAvailable: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Balance correction failed', error.stack);

      return {
        success: false,
        message: `Balance correction failed: ${error.message}`,
        correctedRecords: 0,
        errors: [error.message],
        rollbackAvailable: false,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Remove duplicate records
   */
  async removeDuplicateRecords(
    recordType: 'member' | 'loan' | 'deposit',
    keepStrategy: 'oldest' | 'newest' | 'manual',
    manualKeepIds?: number[],
  ): Promise<CorrectionResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let correctedRecords = 0;
      const errors: string[] = [];

      if (recordType === 'member') {
        const result = await this.removeDuplicateMembers(keepStrategy, manualKeepIds, queryRunner);
        correctedRecords += result.removed;
        errors.push(...result.errors);
      }
      // Add other record types as needed

      await queryRunner.commitTransaction();

      return {
        success: errors.length === 0,
        message: `Removed ${correctedRecords} duplicate records`,
        correctedRecords,
        errors,
        rollbackAvailable: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Duplicate removal failed', error.stack);

      return {
        success: false,
        message: `Duplicate removal failed: ${error.message}`,
        correctedRecords: 0,
        errors: [error.message],
        rollbackAvailable: false,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Fix data integrity issues
   */
  async fixDataIntegrityIssues(): Promise<CorrectionResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let correctedRecords = 0;
      const errors: string[] = [];

      // Fix members with missing required data
      const membersWithMissingData = await queryRunner.manager
        .createQueryBuilder(Member, 'member')
        .where('member.firstName IS NULL OR member.firstName = :empty', { empty: '' })
        .orWhere('member.lastName IS NULL OR member.lastName = :empty', { empty: '' })
        .getMany();

      for (const member of membersWithMissingData) {
        try {
          if (!member.firstName) member.firstName = 'Unknown';
          if (!member.lastName) member.lastName = 'Member';
          
          await queryRunner.manager.save(Member, member);
          correctedRecords++;
        } catch (error) {
          errors.push(`Member ${member.id}: ${error.message}`);
        }
      }

      // Fix loans with invalid amounts
      const loansWithInvalidAmounts = await queryRunner.manager
        .createQueryBuilder(LoanAccount, 'loan')
        .where('loan.principalAmount <= 0')
        .orWhere('loan.outstandingBalance < 0')
        .getMany();

      for (const loan of loansWithInvalidAmounts) {
        try {
          if (loan.principalAmount <= 0) {
            // Set to minimum valid amount or mark for review
            loan.principalAmount = 1000; // Default minimum
          }
          if (loan.outstandingBalance < 0) {
            loan.outstandingBalance = 0;
          }
          
          await queryRunner.manager.save(LoanAccount, loan);
          correctedRecords++;
        } catch (error) {
          errors.push(`Loan ${loan.id}: ${error.message}`);
        }
      }

      await queryRunner.commitTransaction();

      return {
        success: errors.length === 0,
        message: `Fixed ${correctedRecords} data integrity issues`,
        correctedRecords,
        errors,
        rollbackAvailable: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Data integrity fix failed', error.stack);

      return {
        success: false,
        message: `Data integrity fix failed: ${error.message}`,
        correctedRecords: 0,
        errors: [error.message],
        rollbackAvailable: false,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Recalculate all balances
   */
  async recalculateAllBalances(): Promise<CorrectionResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let correctedRecords = 0;
      const errors: string[] = [];

      // Recalculate loan balances
      const loans = await queryRunner.manager.find(LoanAccount, {
        relations: ['payments'],
        where: { status: 'ACTIVE' },
      });

      for (const loan of loans) {
        try {
          const totalPayments = loan.payments?.reduce((sum, payment) => sum + payment.amount, 0) || 0;
          const calculatedBalance = loan.principalAmount - totalPayments;
          
          if (Math.abs(calculatedBalance - loan.outstandingBalance) > 0.01) {
            loan.outstandingBalance = calculatedBalance;
            await queryRunner.manager.save(LoanAccount, loan);
            correctedRecords++;
          }
        } catch (error) {
          errors.push(`Loan ${loan.id}: ${error.message}`);
        }
      }

      // Recalculate deposit maturity amounts
      const deposits = await queryRunner.manager.find(FixedDeposit, {
        where: { status: 'ACTIVE' },
      });

      for (const deposit of deposits) {
        try {
          const daysDiff = Math.ceil(
            (deposit.maturityDate.getTime() - deposit.depositDate.getTime()) / (1000 * 60 * 60 * 24),
          );
          const years = daysDiff / 365;
          const calculatedMaturity = deposit.principalAmount * Math.pow(1 + deposit.interestRate / 100, years);
          
          if (Math.abs(calculatedMaturity - deposit.maturityAmount) > 0.01) {
            deposit.maturityAmount = calculatedMaturity;
            await queryRunner.manager.save(FixedDeposit, deposit);
            correctedRecords++;
          }
        } catch (error) {
          errors.push(`Deposit ${deposit.id}: ${error.message}`);
        }
      }

      await queryRunner.commitTransaction();

      return {
        success: errors.length === 0,
        message: `Recalculated ${correctedRecords} balances`,
        correctedRecords,
        errors,
        rollbackAvailable: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Balance recalculation failed', error.stack);

      return {
        success: false,
        message: `Balance recalculation failed: ${error.message}`,
        correctedRecords: 0,
        errors: [error.message],
        rollbackAvailable: false,
      };
    } finally {
      await queryRunner.release();
    }
  }

  private async fixSpecificIssue(check: ConsistencyCheckResult): Promise<CorrectionResult> {
    switch (check.checkName) {
      case 'Orphaned Records Check':
        return this.autoFixOrphanedRecords(check);
      case 'Balance Consistency Check':
        return this.autoFixBalanceDiscrepancies(check);
      case 'Data Integrity Check':
        return this.fixDataIntegrityIssues();
      default:
        throw new BadRequestException(`No auto-fix available for ${check.checkName}`);
    }
  }

  private async autoFixOrphanedRecords(check: ConsistencyCheckResult): Promise<CorrectionResult> {
    // Auto-delete orphaned records (be careful with this in production)
    const fixes: OrphanedRecordFix[] = [];
    
    if (check.details && check.details[0]) {
      const orphanedData = check.details[0];
      
      // Mark orphaned payments for deletion
      orphanedData.orphanedPayments?.forEach((payment: any) => {
        fixes.push({
          recordType: 'payment',
          recordId: payment.id,
          action: 'delete',
        });
      });
      
      // Mark orphaned transactions for archiving
      orphanedData.orphanedTransactions?.forEach((transaction: any) => {
        fixes.push({
          recordType: 'transaction',
          recordId: transaction.id,
          action: 'archive',
        });
      });
    }

    return this.fixOrphanedRecords(fixes);
  }

  private async autoFixBalanceDiscrepancies(check: ConsistencyCheckResult): Promise<CorrectionResult> {
    const corrections: BalanceCorrectionRequest[] = [];
    
    if (check.details) {
      check.details.forEach((discrepancy: any) => {
        corrections.push({
          accountType: discrepancy.accountType.toLowerCase(),
          accountId: discrepancy.accountId,
          correctedBalance: discrepancy.calculatedBalance,
          reason: 'Auto-correction from consistency check',
          createAdjustmentEntry: true,
        });
      });
    }

    return this.correctBalanceDiscrepancies(corrections);
  }

  private async fixOrphanedLoan(fix: OrphanedRecordFix, queryRunner: QueryRunner): Promise<void> {
    if (fix.action === 'delete') {
      await queryRunner.manager.delete(LoanAccount, fix.recordId);
    } else if (fix.action === 'reassign' && fix.newParentId) {
      await queryRunner.manager.update(
        LoanAccount,
        fix.recordId,
        { member: { id: fix.newParentId } },
      );
    }
  }

  private async fixOrphanedDeposit(fix: OrphanedRecordFix, queryRunner: QueryRunner): Promise<void> {
    if (fix.action === 'delete') {
      await queryRunner.manager.delete(FixedDeposit, fix.recordId);
    } else if (fix.action === 'reassign' && fix.newParentId) {
      await queryRunner.manager.update(
        FixedDeposit,
        fix.recordId,
        { member: { id: fix.newParentId } },
      );
    }
  }

  private async fixOrphanedPayment(fix: OrphanedRecordFix, queryRunner: QueryRunner): Promise<void> {
    if (fix.action === 'delete') {
      await queryRunner.manager.delete(LoanPayment, fix.recordId);
    }
  }

  private async fixOrphanedTransaction(fix: OrphanedRecordFix, queryRunner: QueryRunner): Promise<void> {
    if (fix.action === 'delete') {
      await queryRunner.manager.delete(Transaction, fix.recordId);
    } else if (fix.action === 'archive') {
      await queryRunner.manager.update(
        Transaction,
        fix.recordId,
        { description: `[ARCHIVED] ${fix.recordId}` },
      );
    }
  }

  private async correctLoanBalance(
    correction: BalanceCorrectionRequest,
    queryRunner: QueryRunner,
  ): Promise<void> {
    const loan = await queryRunner.manager.findOne(LoanAccount, {
      where: { id: correction.accountId },
    });

    if (!loan) {
      throw new NotFoundException(`Loan account ${correction.accountId} not found`);
    }

    const oldBalance = loan.outstandingBalance;
    loan.outstandingBalance = correction.correctedBalance;

    await queryRunner.manager.save(LoanAccount, loan);

    if (correction.createAdjustmentEntry) {
      // Create adjustment transaction
      const adjustment = queryRunner.manager.create(Transaction, {
        transactionNumber: `ADJ-${Date.now()}`,
        transactionDate: new Date(),
        transactionType: 'BALANCE_ADJUSTMENT',
        amount: Math.abs(correction.correctedBalance - oldBalance),
        description: `Balance adjustment: ${correction.reason}`,
        debitAccount: correction.correctedBalance > oldBalance ? 'LOAN_ACCOUNT' : 'ADJUSTMENT_ACCOUNT',
        creditAccount: correction.correctedBalance > oldBalance ? 'ADJUSTMENT_ACCOUNT' : 'LOAN_ACCOUNT',
        member: loan.member,
      });

      await queryRunner.manager.save(Transaction, adjustment);
    }
  }

  private async correctDepositBalance(
    correction: BalanceCorrectionRequest,
    queryRunner: QueryRunner,
  ): Promise<void> {
    const deposit = await queryRunner.manager.findOne(FixedDeposit, {
      where: { id: correction.accountId },
    });

    if (!deposit) {
      throw new NotFoundException(`Deposit account ${correction.accountId} not found`);
    }

    deposit.maturityAmount = correction.correctedBalance;
    await queryRunner.manager.save(FixedDeposit, deposit);
  }

  private async removeDuplicateMembers(
    keepStrategy: 'oldest' | 'newest' | 'manual',
    manualKeepIds: number[] = [],
    queryRunner: QueryRunner,
  ): Promise<{ removed: number; errors: string[] }> {
    const errors: string[] = [];
    let removed = 0;

    // Find duplicate phone numbers
    const duplicatePhones = await queryRunner.manager
      .createQueryBuilder(Member, 'member')
      .select(['member.phoneNumber', 'COUNT(*) as count'])
      .groupBy('member.phoneNumber')
      .having('COUNT(*) > 1')
      .getRawMany();

    for (const duplicate of duplicatePhones) {
      try {
        const members = await queryRunner.manager.find(Member, {
          where: { phoneNumber: duplicate.phoneNumber },
          order: { createdAt: 'ASC' },
        });

        let keepMember: Member;
        if (keepStrategy === 'manual' && manualKeepIds.length > 0) {
          keepMember = members.find(m => manualKeepIds.includes(m.id)) || members[0];
        } else if (keepStrategy === 'newest') {
          keepMember = members[members.length - 1];
        } else {
          keepMember = members[0]; // oldest
        }

        const toRemove = members.filter(m => m.id !== keepMember.id);
        
        for (const member of toRemove) {
          await queryRunner.manager.delete(Member, member.id);
          removed++;
        }
      } catch (error) {
        errors.push(`Phone ${duplicate.phoneNumber}: ${error.message}`);
      }
    }

    return { removed, errors };
  }
}
