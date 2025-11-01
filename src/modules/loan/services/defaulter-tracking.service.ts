import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan } from 'typeorm';
import { LoanAccount } from '../entities/loan-account.entity';
import { Cron, CronExpression } from '@nestjs/schedule';

export interface DefaulterInfo {
  loanId: number;
  accountNumber: string;
  memberId: number;
  memberNumber: string;
  memberName: string;
  phoneNumber: string;
  principalAmount: number;
  outstandingBalance: number;
  totalInterestAccrued: number;
  daysPastDue: number;
  maturityDate: Date;
  lastPaymentDate?: Date;
  defaulterCategory: 'MILD' | 'MODERATE' | 'SEVERE' | 'CRITICAL';
  recommendedAction: string;
}

export interface DefaulterSummary {
  totalDefaulters: number;
  totalOutstandingAmount: number;
  categoryBreakdown: {
    mild: number;
    moderate: number;
    severe: number;
    critical: number;
  };
  amountBreakdown: {
    mild: number;
    moderate: number;
    severe: number;
    critical: number;
  };
}

@Injectable()
export class DefaulterTrackingService {
  constructor(
    @InjectRepository(LoanAccount)
    private readonly loanRepository: Repository<LoanAccount>,
  ) {}

  /**
   * Get comprehensive defaulter list with categorization
   */
  async getDefaulterList(): Promise<DefaulterInfo[]> {
    const currentDate = new Date();
    
    const overdueLoans = await this.loanRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member')
      .leftJoinAndSelect('loan.payments', 'payments')
      .where('loan.status = :status', { status: 'ACTIVE' })
      .andWhere('loan.maturityDate < :currentDate', { currentDate })
      .orderBy('loan.maturityDate', 'ASC')
      .getMany();

    return overdueLoans.map(loan => this.mapToDefaulterInfo(loan, currentDate));
  }

  /**
   * Get defaulter summary statistics
   */
  async getDefaulterSummary(): Promise<DefaulterSummary> {
    const defaulters = await this.getDefaulterList();
    
    const summary: DefaulterSummary = {
      totalDefaulters: defaulters.length,
      totalOutstandingAmount: 0,
      categoryBreakdown: {
        mild: 0,
        moderate: 0,
        severe: 0,
        critical: 0,
      },
      amountBreakdown: {
        mild: 0,
        moderate: 0,
        severe: 0,
        critical: 0,
      },
    };

    defaulters.forEach(defaulter => {
      summary.totalOutstandingAmount += defaulter.outstandingBalance;
      
      const category = defaulter.defaulterCategory.toLowerCase() as keyof typeof summary.categoryBreakdown;
      summary.categoryBreakdown[category]++;
      summary.amountBreakdown[category] += defaulter.outstandingBalance;
    });

    return summary;
  }

  /**
   * Get defaulters by category
   */
  async getDefaultersByCategory(category: 'MILD' | 'MODERATE' | 'SEVERE' | 'CRITICAL'): Promise<DefaulterInfo[]> {
    const allDefaulters = await this.getDefaulterList();
    return allDefaulters.filter(defaulter => defaulter.defaulterCategory === category);
  }

  /**
   * Get defaulters by days past due range
   */
  async getDefaultersByDaysRange(minDays: number, maxDays?: number): Promise<DefaulterInfo[]> {
    const allDefaulters = await this.getDefaulterList();
    
    return allDefaulters.filter(defaulter => {
      if (maxDays) {
        return defaulter.daysPastDue >= minDays && defaulter.daysPastDue <= maxDays;
      }
      return defaulter.daysPastDue >= minDays;
    });
  }

  /**
   * Mark loans as defaulted based on days past due
   */
  async markLoansAsDefaulted(daysPastDue: number = 90): Promise<{
    markedCount: number;
    markedLoans: Array<{ id: number; accountNumber: string; memberName: string }>;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysPastDue);

    // Get loans to be marked as defaulted
    const loansToDefault = await this.loanRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member')
      .where('loan.status = :status', { status: 'ACTIVE' })
      .andWhere('loan.maturityDate < :cutoffDate', { cutoffDate })
      .getMany();

    // Mark them as defaulted
    const result = await this.loanRepository
      .createQueryBuilder()
      .update(LoanAccount)
      .set({ status: 'DEFAULTED' })
      .where('status = :status', { status: 'ACTIVE' })
      .andWhere('maturityDate < :cutoffDate', { cutoffDate })
      .execute();

    return {
      markedCount: result.affected || 0,
      markedLoans: loansToDefault.map(loan => ({
        id: loan.id,
        accountNumber: loan.accountNumber,
        memberName: loan.member.fullName,
      })),
    };
  }

  /**
   * Generate defaulter report for a specific period
   */
  async generateDefaulterReport(fromDate: Date, toDate: Date): Promise<{
    reportPeriod: { from: Date; to: Date };
    newDefaulters: DefaulterInfo[];
    recoveredLoans: Array<{ id: number; accountNumber: string; memberName: string; recoveredAmount: number }>;
    summary: DefaulterSummary;
  }> {
    // Get loans that became overdue in the specified period
    const newDefaulters = await this.loanRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member')
      .leftJoinAndSelect('loan.payments', 'payments')
      .where('loan.status = :status', { status: 'ACTIVE' })
      .andWhere('loan.maturityDate BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .getMany();

    // Get loans that were closed/recovered in the period
    const recoveredLoans = await this.loanRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member')
      .where('loan.status = :status', { status: 'CLOSED' })
      .andWhere('loan.closureDate BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .andWhere('loan.maturityDate < loan.closureDate') // Was overdue before closure
      .getMany();

    const currentDate = new Date();
    const defaulterInfos = newDefaulters.map(loan => this.mapToDefaulterInfo(loan, currentDate));
    
    return {
      reportPeriod: { from: fromDate, to: toDate },
      newDefaulters: defaulterInfos,
      recoveredLoans: recoveredLoans.map(loan => ({
        id: loan.id,
        accountNumber: loan.accountNumber,
        memberName: loan.member.fullName,
        recoveredAmount: Number(loan.principalAmount),
      })),
      summary: await this.getDefaulterSummary(),
    };
  }

  /**
   * Get recovery suggestions for defaulters
   */
  async getRecoverySuggestions(loanId: number): Promise<{
    loanInfo: DefaulterInfo;
    suggestions: Array<{
      action: string;
      description: string;
      priority: 'HIGH' | 'MEDIUM' | 'LOW';
      estimatedRecoveryAmount: number;
    }>;
  }> {
    const loan = await this.loanRepository.findOne({
      where: { id: loanId },
      relations: ['member', 'payments'],
    });

    if (!loan) {
      throw new Error('Loan not found');
    }

    const defaulterInfo = this.mapToDefaulterInfo(loan, new Date());
    const suggestions = this.generateRecoverySuggestions(defaulterInfo);

    return {
      loanInfo: defaulterInfo,
      suggestions,
    };
  }

  /**
   * Automated defaulter tracking - runs daily
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async automatedDefaulterTracking(): Promise<void> {
    console.log('Starting automated defaulter tracking...');
    
    try {
      const summary = await this.getDefaulterSummary();
      console.log(`Total defaulters: ${summary.totalDefaulters}`);
      console.log(`Total outstanding amount: ₹${summary.totalOutstandingAmount.toFixed(2)}`);
      
      // Mark severely overdue loans as defaulted (90+ days)
      const markedResult = await this.markLoansAsDefaulted(90);
      if (markedResult.markedCount > 0) {
        console.log(`Marked ${markedResult.markedCount} loans as defaulted`);
      }
      
    } catch (error) {
      console.error('Error in automated defaulter tracking:', error);
    }
  }

  /**
   * Private method to map loan to defaulter info
   */
  private mapToDefaulterInfo(loan: LoanAccount, currentDate: Date): DefaulterInfo {
    const daysPastDue = Math.floor(
      (currentDate.getTime() - loan.maturityDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Get last payment date
    const lastPayment = loan.payments && loan.payments.length > 0 
      ? loan.payments.sort((a, b) => b.paymentDate.getTime() - a.paymentDate.getTime())[0]
      : null;

    const category = this.categorizeDefaulter(daysPastDue);
    const recommendedAction = this.getRecommendedAction(category, daysPastDue);

    return {
      loanId: loan.id,
      accountNumber: loan.accountNumber,
      memberId: loan.member.id,
      memberNumber: loan.member.memberNumber,
      memberName: loan.member.fullName,
      phoneNumber: loan.member.phoneNumber,
      principalAmount: Number(loan.principalAmount),
      outstandingBalance: Number(loan.outstandingBalance),
      totalInterestAccrued: Number(loan.totalInterestAccrued),
      daysPastDue,
      maturityDate: loan.maturityDate,
      lastPaymentDate: lastPayment?.paymentDate,
      defaulterCategory: category,
      recommendedAction,
    };
  }

  /**
   * Categorize defaulter based on days past due
   */
  private categorizeDefaulter(daysPastDue: number): 'MILD' | 'MODERATE' | 'SEVERE' | 'CRITICAL' {
    if (daysPastDue <= 30) return 'MILD';
    if (daysPastDue <= 60) return 'MODERATE';
    if (daysPastDue <= 90) return 'SEVERE';
    return 'CRITICAL';
  }

  /**
   * Get recommended action based on defaulter category
   */
  private getRecommendedAction(category: string, daysPastDue: number): string {
    switch (category) {
      case 'MILD':
        return 'Send reminder notice and make phone call';
      case 'MODERATE':
        return 'Send formal notice and schedule meeting';
      case 'SEVERE':
        return 'Issue legal notice and involve guarantor';
      case 'CRITICAL':
        return 'Initiate recovery proceedings and asset seizure';
      default:
        return 'Contact member immediately';
    }
  }

  /**
   * Generate recovery suggestions based on defaulter info
   */
  private generateRecoverySuggestions(defaulterInfo: DefaulterInfo): Array<{
    action: string;
    description: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    estimatedRecoveryAmount: number;
  }> {
    const suggestions = [];
    const outstandingAmount = defaulterInfo.outstandingBalance;

    // Phone call/reminder
    suggestions.push({
      action: 'Phone Call Reminder',
      description: 'Contact member via phone to discuss payment options',
      priority: 'HIGH' as const,
      estimatedRecoveryAmount: outstandingAmount * 0.3,
    });

    // Restructure loan
    if (defaulterInfo.defaulterCategory !== 'CRITICAL') {
      suggestions.push({
        action: 'Loan Restructuring',
        description: 'Offer to restructure the loan with extended tenure',
        priority: 'MEDIUM' as const,
        estimatedRecoveryAmount: outstandingAmount * 0.7,
      });
    }

    // Partial settlement
    suggestions.push({
      action: 'Partial Settlement',
      description: 'Negotiate for partial payment to close the loan',
      priority: 'MEDIUM' as const,
      estimatedRecoveryAmount: outstandingAmount * 0.6,
    });

    // Legal action
    if (defaulterInfo.defaulterCategory === 'SEVERE' || defaulterInfo.defaulterCategory === 'CRITICAL') {
      suggestions.push({
        action: 'Legal Action',
        description: 'Initiate legal proceedings for recovery',
        priority: 'HIGH' as const,
        estimatedRecoveryAmount: outstandingAmount * 0.8,
      });
    }

    // Guarantor involvement
    suggestions.push({
      action: 'Contact Guarantor',
      description: 'Involve loan guarantor/surety for recovery',
      priority: 'HIGH' as const,
      estimatedRecoveryAmount: outstandingAmount * 0.5,
    });

    return suggestions;
  }
}
