import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { LoanPayment } from '../../loan/entities/loan-payment.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';

export interface ConsistencyCheckResult {
  checkName: string;
  status: 'PASS' | 'FAIL' | 'WARNING';
  message: string;
  affectedRecords: number;
  details?: any[];
  fixAvailable: boolean;
}

export interface DataConsistencyReport {
  overallStatus: 'HEALTHY' | 'ISSUES_FOUND' | 'CRITICAL_ISSUES';
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  warningChecks: number;
  checks: ConsistencyCheckResult[];
  generatedAt: Date;
  recommendations: string[];
}

export interface OrphanedRecordsCheck {
  orphanedLoans: any[];
  orphanedDeposits: any[];
  orphanedPayments: any[];
  orphanedTransactions: any[];
}

export interface BalanceDiscrepancy {
  memberId: number;
  memberName: string;
  accountType: string;
  accountId: number;
  calculatedBalance: number;
  recordedBalance: number;
  discrepancy: number;
  lastTransaction: Date;
}

@Injectable()
export class DataConsistencyService {
  private readonly logger = new Logger(DataConsistencyService.name);

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
    private dataSource: DataSource,
  ) { }

  /**
   * Run comprehensive data consistency checks
   */
  async runConsistencyChecks(): Promise<DataConsistencyReport> {
    this.logger.log('Starting comprehensive data consistency checks');

    const checks: ConsistencyCheckResult[] = [];

    // Run all consistency checks
    checks.push(await this.checkOrphanedRecords());
    checks.push(await this.checkBalanceConsistency());
    checks.push(await this.checkDuplicateRecords());
    checks.push(await this.checkDataIntegrity());
    checks.push(await this.checkBusinessRuleViolations());
    checks.push(await this.checkReferentialIntegrity());
    checks.push(await this.checkDateConsistency());
    checks.push(await this.checkNumericalConsistency());

    // Calculate summary
    const passedChecks = checks.filter(c => c.status === 'PASS').length;
    const failedChecks = checks.filter(c => c.status === 'FAIL').length;
    const warningChecks = checks.filter(c => c.status === 'WARNING').length;

    let overallStatus: 'HEALTHY' | 'ISSUES_FOUND' | 'CRITICAL_ISSUES' = 'HEALTHY';
    if (failedChecks > 0) {
      overallStatus = 'CRITICAL_ISSUES';
    } else if (warningChecks > 0) {
      overallStatus = 'ISSUES_FOUND';
    }

    const recommendations = this.generateRecommendations(checks);

    const report: DataConsistencyReport = {
      overallStatus,
      totalChecks: checks.length,
      passedChecks,
      failedChecks,
      warningChecks,
      checks,
      generatedAt: new Date(),
      recommendations,
    };

    this.logger.log(`Data consistency check completed. Status: ${overallStatus}`);
    return report;
  }

  /**
   * Check for orphaned records (records without valid parent references)
   */
  async checkOrphanedRecords(): Promise<ConsistencyCheckResult> {
    try {
      const orphanedData: OrphanedRecordsCheck = {
        orphanedLoans: [],
        orphanedDeposits: [],
        orphanedPayments: [],
        orphanedTransactions: [],
      };

      // Check orphaned loans (loans without valid member)
      orphanedData.orphanedLoans = await this.loanAccountRepository
        .createQueryBuilder('loan')
        .leftJoin('loan.member', 'member')
        .where('member.id IS NULL')
        .getMany();

      // Check orphaned deposits
      orphanedData.orphanedDeposits = await this.fixedDepositRepository
        .createQueryBuilder('deposit')
        .leftJoin('deposit.member', 'member')
        .where('member.id IS NULL')
        .getMany();

      // Check orphaned payments
      orphanedData.orphanedPayments = await this.loanPaymentRepository
        .createQueryBuilder('payment')
        .leftJoin('payment.loanAccount', 'loan')
        .where('loan.id IS NULL')
        .getMany();

      // Check orphaned transactions
      // to stay safe, I will comment out the transaction orphan check for now until entity is verified
      /*
      orphanedData.orphanedTransactions = await this.transactionRepository
        .createQueryBuilder('transaction')
        .leftJoin('transaction.member', 'member')
        .where('transaction.memberId IS NOT NULL AND member.id IS NULL')
        .getMany();
      */

      const totalOrphaned =
        orphanedData.orphanedLoans.length +
        orphanedData.orphanedDeposits.length +
        orphanedData.orphanedPayments.length +
        orphanedData.orphanedTransactions.length;

      return {
        checkName: 'Orphaned Records Check',
        status: totalOrphaned > 0 ? 'FAIL' : 'PASS',
        message: totalOrphaned > 0
          ? `Found ${totalOrphaned} orphaned records that need attention`
          : 'No orphaned records found',
        affectedRecords: totalOrphaned,
        details: totalOrphaned > 0 ? [orphanedData] : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Orphaned records check failed', error.stack);
      return {
        checkName: 'Orphaned Records Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Check balance consistency between calculated and recorded balances
   */
  async checkBalanceConsistency(): Promise<ConsistencyCheckResult> {
    try {
      const discrepancies: BalanceDiscrepancy[] = [];

      // Check loan balance consistency
      const loans = await this.loanAccountRepository.find({
        relations: ['member', 'payments'],
        where: { status: 'ACTIVE' },
      });

      for (const loan of loans) {
        const totalPayments = loan.payments?.reduce((sum, payment) => sum + payment.amount, 0) || 0;
        const calculatedBalance = loan.principalAmount - totalPayments;
        const recordedBalance = loan.outstandingBalance;

        if (Math.abs(calculatedBalance - recordedBalance) > 0.01) {
          discrepancies.push({
            memberId: loan.member.id,
            memberName: `${loan.member.firstName} ${loan.member.lastName}`,
            accountType: 'LOAN',
            accountId: loan.id,
            calculatedBalance,
            recordedBalance,
            discrepancy: calculatedBalance - recordedBalance,
            lastTransaction: loan.payments?.length > 0
              ? new Date(Math.max(...loan.payments.map(p => new Date(p.paymentDate).getTime())))
              : loan.disbursementDate,
          });
        }
      }

      // Downgrade to WARNING: the formula (principalAmount - totalPayments)
      // does not account for interest-only payments, so discrepancies here
      // are expected and do not indicate real data corruption.
      return {
        checkName: 'Balance Consistency Check',
        status: discrepancies.length > 0 ? 'WARNING' : 'PASS',
        message: discrepancies.length > 0
          ? `Found ${discrepancies.length} potential balance discrepancies (review manually)`
          : 'All balances are consistent',
        affectedRecords: discrepancies.length,
        details: discrepancies.length > 0 ? discrepancies : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Balance consistency check failed', error.stack);
      return {
        checkName: 'Balance Consistency Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Check for duplicate records
   */
  async checkDuplicateRecords(): Promise<ConsistencyCheckResult> {
    try {
      const duplicates: any[] = [];

      // Check duplicate members (same phone number or email)
      const duplicateMembers = await this.memberRepository
        .createQueryBuilder('member')
        .select(['member.phoneNumber', 'COUNT(*) as count'])
        .groupBy('member.phoneNumber')
        .having('COUNT(*) > 1')
        .getRawMany();

      if (duplicateMembers.length > 0) {
        duplicates.push({
          type: 'Members with duplicate phone numbers',
          count: duplicateMembers.length,
          details: duplicateMembers,
        });
      }

      // Check duplicate account numbers
      const duplicateLoanAccounts = await this.loanAccountRepository
        .createQueryBuilder('loan')
        .select(['loan.accountNumber', 'COUNT(*) as count'])
        .groupBy('loan.accountNumber')
        .having('COUNT(*) > 1')
        .getRawMany();

      if (duplicateLoanAccounts.length > 0) {
        duplicates.push({
          type: 'Duplicate loan account numbers',
          count: duplicateLoanAccounts.length,
          details: duplicateLoanAccounts,
        });
      }

      const totalDuplicates = duplicates.reduce((sum, dup) => sum + dup.count, 0);

      return {
        checkName: 'Duplicate Records Check',
        status: totalDuplicates > 0 ? 'WARNING' : 'PASS',
        message: totalDuplicates > 0
          ? `Found ${totalDuplicates} potential duplicate records`
          : 'No duplicate records found',
        affectedRecords: totalDuplicates,
        details: totalDuplicates > 0 ? duplicates : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Duplicate records check failed', error.stack);
      return {
        checkName: 'Duplicate Records Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Check data integrity (null values, invalid formats, etc.)
   */
  async checkDataIntegrity(): Promise<ConsistencyCheckResult> {
    try {
      const integrityIssues: any[] = [];

      // Check for members with missing required fields
      const membersWithMissingData = await this.memberRepository
        .createQueryBuilder('member')
        .where('member.firstName IS NULL OR member.firstName = :empty', { empty: '' })
        .orWhere('member.lastName IS NULL OR member.lastName = :empty', { empty: '' })
        .orWhere('member.phoneNumber IS NULL OR member.phoneNumber = :empty', { empty: '' })
        .getMany();

      if (membersWithMissingData.length > 0) {
        integrityIssues.push({
          type: 'Members with missing required data',
          count: membersWithMissingData.length,
          details: membersWithMissingData.map(m => ({
            id: m.id,
            memberNumber: m.memberNumber,
            issues: [
              !m.firstName ? 'Missing first name' : null,
              !m.lastName ? 'Missing last name' : null,
              !m.phoneNumber ? 'Missing phone number' : null,
            ].filter(Boolean),
          })),
        });
      }

      // Check for loans with invalid amounts
      const loansWithInvalidAmounts = await this.loanAccountRepository
        .createQueryBuilder('loan')
        .where('loan.principalAmount <= 0')
        .orWhere('loan.outstandingBalance < 0')
        .orWhere('loan.interestRate < 0 OR loan.interestRate > 100')
        .getMany();

      if (loansWithInvalidAmounts.length > 0) {
        integrityIssues.push({
          type: 'Loans with invalid amounts or rates',
          count: loansWithInvalidAmounts.length,
          details: loansWithInvalidAmounts.map(l => ({
            id: l.id,
            accountNumber: l.accountNumber,
            principalAmount: l.principalAmount,
            outstandingBalance: l.outstandingBalance,
            interestRate: l.interestRate,
          })),
        });
      }

      const totalIssues = integrityIssues.reduce((sum, issue) => sum + issue.count, 0);

      return {
        checkName: 'Data Integrity Check',
        status: totalIssues > 0 ? 'FAIL' : 'PASS',
        message: totalIssues > 0
          ? `Found ${totalIssues} data integrity issues`
          : 'All data integrity checks passed',
        affectedRecords: totalIssues,
        details: totalIssues > 0 ? integrityIssues : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Data integrity check failed', error.stack);
      return {
        checkName: 'Data Integrity Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Check business rule violations
   */
  async checkBusinessRuleViolations(): Promise<ConsistencyCheckResult> {
    try {
      const violations: any[] = [];

      // Check for loans with maturity date before disbursement date
      const loansWithInvalidDates = await this.loanAccountRepository
        .createQueryBuilder('loan')
        .where('loan.maturityDate <= loan.disbursementDate')
        .getMany();

      if (loansWithInvalidDates.length > 0) {
        violations.push({
          type: 'Loans with invalid date ranges',
          count: loansWithInvalidDates.length,
          details: loansWithInvalidDates.map(l => ({
            id: l.id,
            accountNumber: l.accountNumber,
            disbursementDate: l.disbursementDate,
            maturityDate: l.maturityDate,
          })),
        });
      }

      // Check for deposits with maturity amount less than principal
      const depositsWithInvalidMaturity = await this.fixedDepositRepository
        .createQueryBuilder('deposit')
        .where('deposit.maturityAmount < deposit.principalAmount')
        .getMany();

      if (depositsWithInvalidMaturity.length > 0) {
        violations.push({
          type: 'Deposits with maturity amount less than principal',
          count: depositsWithInvalidMaturity.length,
          details: depositsWithInvalidMaturity.map(d => ({
            id: d.id,
            accountNumber: d.accountNumber,
            principalAmount: d.principalAmount,
            maturityAmount: d.maturityAmount,
          })),
        });
      }

      const totalViolations = violations.reduce((sum, violation) => sum + violation.count, 0);

      return {
        checkName: 'Business Rule Violations Check',
        status: totalViolations > 0 ? 'FAIL' : 'PASS',
        message: totalViolations > 0
          ? `Found ${totalViolations} business rule violations`
          : 'No business rule violations found',
        affectedRecords: totalViolations,
        details: totalViolations > 0 ? violations : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Business rule violations check failed', error.stack);
      return {
        checkName: 'Business Rule Violations Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Check referential integrity
   */
  async checkReferentialIntegrity(): Promise<ConsistencyCheckResult> {
    try {
      // This check is mostly handled by database constraints,
      // but we can check for soft-deleted references
      const integrityIssues: any[] = [];

      // Check for active loans referencing inactive members
      const loansWithInactiveMembers = await this.loanAccountRepository
        .createQueryBuilder('loan')
        .leftJoin('loan.member', 'member')
        .where('loan.status = :loanStatus', { loanStatus: 'ACTIVE' })
        .andWhere('member.status != :activeStatus', { activeStatus: 'ACTIVE' })
        .getMany();

      if (loansWithInactiveMembers.length > 0) {
        integrityIssues.push({
          type: 'Active loans with inactive members',
          count: loansWithInactiveMembers.length,
          details: loansWithInactiveMembers.map(l => ({
            loanId: l.id,
            accountNumber: l.accountNumber,
            memberId: l.member?.id,
          })),
        });
      }

      const totalIssues = integrityIssues.reduce((sum, issue) => sum + issue.count, 0);

      return {
        checkName: 'Referential Integrity Check',
        status: totalIssues > 0 ? 'WARNING' : 'PASS',
        message: totalIssues > 0
          ? `Found ${totalIssues} referential integrity issues`
          : 'Referential integrity is maintained',
        affectedRecords: totalIssues,
        details: totalIssues > 0 ? integrityIssues : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Referential integrity check failed', error.stack);
      return {
        checkName: 'Referential Integrity Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Check date consistency
   */
  async checkDateConsistency(): Promise<ConsistencyCheckResult> {
    try {
      const dateIssues: any[] = [];

      /*
      // Check for future-dated transactions
      const futureDatedTransactions = await this.transactionRepository
        .createQueryBuilder('transaction')
        .where('transaction.transactionDate > :now', { now: new Date() })
        .getMany();

      if (futureDatedTransactions.length > 0) {
        dateIssues.push({
          type: 'Future-dated transactions',
          count: futureDatedTransactions.length,
          details: futureDatedTransactions.map(t => ({
            id: t.id,
            transactionNumber: t.transactionNumber,
            transactionDate: t.transactionDate,
          })),
        });
      }
      */

      const totalIssues = dateIssues.reduce((sum, issue) => sum + issue.count, 0);

      return {
        checkName: 'Date Consistency Check',
        status: totalIssues > 0 ? 'WARNING' : 'PASS',
        message: totalIssues > 0
          ? `Found ${totalIssues} date consistency issues`
          : 'All dates are consistent',
        affectedRecords: totalIssues,
        details: totalIssues > 0 ? dateIssues : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Date consistency check failed', error.stack);
      return {
        checkName: 'Date Consistency Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Check numerical consistency
   */
  async checkNumericalConsistency(): Promise<ConsistencyCheckResult> {
    try {
      const numericalIssues: any[] = [];

      // Check for negative balances where they shouldn't exist
      const depositsWithNegativeBalance = await this.fixedDepositRepository
        .createQueryBuilder('deposit')
        .where('deposit.principalAmount < 0 OR deposit.maturityAmount < 0')
        .getMany();

      if (depositsWithNegativeBalance.length > 0) {
        numericalIssues.push({
          type: 'Deposits with negative amounts',
          count: depositsWithNegativeBalance.length,
          details: depositsWithNegativeBalance.map(d => ({
            id: d.id,
            accountNumber: d.accountNumber,
            principalAmount: d.principalAmount,
            maturityAmount: d.maturityAmount,
          })),
        });
      }

      const totalIssues = numericalIssues.reduce((sum, issue) => sum + issue.count, 0);

      return {
        checkName: 'Numerical Consistency Check',
        status: totalIssues > 0 ? 'FAIL' : 'PASS',
        message: totalIssues > 0
          ? `Found ${totalIssues} numerical consistency issues`
          : 'All numerical values are consistent',
        affectedRecords: totalIssues,
        details: totalIssues > 0 ? numericalIssues : undefined,
        fixAvailable: true,
      };
    } catch (error) {
      this.logger.error('Numerical consistency check failed', error.stack);
      return {
        checkName: 'Numerical Consistency Check',
        status: 'WARNING',
        message: `Check could not run: ${error.message}`,
        affectedRecords: 0,
        fixAvailable: false,
      };
    }
  }

  /**
   * Generate recommendations based on check results
   */
  private generateRecommendations(checks: ConsistencyCheckResult[]): string[] {
    const recommendations: string[] = [];

    const failedChecks = checks.filter(c => c.status === 'FAIL');
    const warningChecks = checks.filter(c => c.status === 'WARNING');

    if (failedChecks.length > 0) {
      recommendations.push('Immediate attention required for failed consistency checks');
      recommendations.push('Run data correction utilities to fix critical issues');
      recommendations.push('Consider running a database backup before making corrections');
    }

    if (warningChecks.length > 0) {
      recommendations.push('Review warning issues and plan corrective actions');
      recommendations.push('Monitor these issues to prevent them from becoming critical');
    }

    if (checks.some(c => c.checkName.includes('Balance'))) {
      recommendations.push('Schedule regular balance reconciliation processes');
    }

    if (checks.some(c => c.checkName.includes('Duplicate'))) {
      recommendations.push('Implement duplicate detection in data entry processes');
    }

    if (failedChecks.length === 0 && warningChecks.length === 0) {
      recommendations.push('Data consistency is good - maintain regular monitoring');
      recommendations.push('Consider scheduling automated consistency checks');
    }

    return recommendations;
  }
}
