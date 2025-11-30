import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { LoanAccount } from '../entities/loan-account.entity';
import { Cron, CronExpression } from '@nestjs/schedule';

export interface InterestRate {
  id: number;
  loanType: string;
  minAmount: number;
  maxAmount: number;
  interestRate: number;
  isActive: boolean;
}

export interface InterestCalculationResult {
  loanId: number;
  accountNumber: string;
  principalAmount: number;
  interestRate: number;
  daysCalculated: number;
  interestAmount: number;
  totalInterestAccrued: number;
  calculationDate: Date;
}

@Injectable()
export class InterestCalculationService {
  constructor(
    @InjectRepository(LoanAccount)
    private readonly loanRepository: Repository<LoanAccount>,
  ) {}

  /**
   * Calculate interest for a specific loan
   */
  async calculateLoanInterest(loanId: number): Promise<InterestCalculationResult> {
    const loan = await this.loanRepository.findOne({
      where: { id: loanId },
      relations: ['member'],
    });

    if (!loan) {
      throw new BadRequestException('Loan not found');
    }

    if (loan.status !== 'ACTIVE') {
      throw new BadRequestException('Interest can only be calculated for active loans');
    }

    return this.performInterestCalculation(loan);
  }

  /**
   * Calculate interest for all active loans
   */
  async calculateAllLoansInterest(): Promise<InterestCalculationResult[]> {
    const activeLoans = await this.loanRepository.find({
      where: { status: 'ACTIVE' },
      relations: ['member'],
    });

    const results: InterestCalculationResult[] = [];

    for (const loan of activeLoans) {
      try {
        const result = await this.performInterestCalculation(loan);
        results.push(result);
      } catch (error) {
        console.error(`Error calculating interest for loan ${loan.id}:`, error.message);
      }
    }

    return results;
  }

  /**
   * Get configurable interest rates by loan type and amount slabs
   */
  getInterestRateSlabs(): InterestRate[] {
    // This would typically come from a database table
    // For now, returning hardcoded slabs
    return [
      {
        id: 1,
        loanType: 'PERSONAL',
        minAmount: 0,
        maxAmount: 50000,
        interestRate: 15.0,
        isActive: true,
      },
      {
        id: 2,
        loanType: 'PERSONAL',
        minAmount: 50001,
        maxAmount: 200000,
        interestRate: 13.5,
        isActive: true,
      },
      {
        id: 3,
        loanType: 'PERSONAL',
        minAmount: 200001,
        maxAmount: 500000,
        interestRate: 12.0,
        isActive: true,
      },
      {
        id: 4,
        loanType: 'BUSINESS',
        minAmount: 0,
        maxAmount: 100000,
        interestRate: 14.0,
        isActive: true,
      },
      {
        id: 5,
        loanType: 'BUSINESS',
        minAmount: 100001,
        maxAmount: 500000,
        interestRate: 12.5,
        isActive: true,
      },
      {
        id: 6,
        loanType: 'EDUCATION',
        minAmount: 0,
        maxAmount: 300000,
        interestRate: 10.5,
        isActive: true,
      },
      {
        id: 7,
        loanType: 'VEHICLE',
        minAmount: 0,
        maxAmount: 1000000,
        interestRate: 11.5,
        isActive: true,
      },
      {
        id: 8,
        loanType: 'HOME',
        minAmount: 0,
        maxAmount: 2000000,
        interestRate: 9.5,
        isActive: true,
      },
      {
        id: 9,
        loanType: 'GOLD',
        minAmount: 0,
        maxAmount: 500000,
        interestRate: 8.5,
        isActive: true,
      },
    ];
  }

  /**
   * Get applicable interest rate for a loan type and amount
   */
  getApplicableInterestRate(loanType: string, amount: number): number {
    const slabs = this.getInterestRateSlabs();
    
    const applicableSlab = slabs.find(
      slab =>
        slab.loanType === loanType &&
        slab.isActive &&
        amount >= slab.minAmount &&
        amount <= slab.maxAmount,
    );

    if (!applicableSlab) {
      // Return default rate if no slab found
      return 12.0;
    }

    return applicableSlab.interestRate;
  }

  /**
   * Calculate compound interest
   */
  calculateCompoundInterest(
    principal: number,
    rate: number,
    time: number,
    compoundingFrequency: number = 12, // Monthly compounding
  ): number {
    const rateDecimal = rate / 100;
    const amount = principal * Math.pow(1 + rateDecimal / compoundingFrequency, compoundingFrequency * time);
    return amount - principal;
  }

  /**
   * Calculate simple interest
   */
  calculateSimpleInterest(principal: number, rate: number, time: number): number {
    return (principal * rate * time) / 100;
  }

  /**
   * Calculate EMI (Equated Monthly Installment)
   */
  calculateEMI(principal: number, annualRate: number, tenureMonths: number): number {
    const monthlyRate = annualRate / 100 / 12;
    
    if (monthlyRate === 0) {
      return principal / tenureMonths;
    }

    const emi = (principal * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths)) /
                 (Math.pow(1 + monthlyRate, tenureMonths) - 1);
    
    return Math.round(emi * 100) / 100;
  }

  /**
   * Generate amortization schedule
   */
  generateAmortizationSchedule(
    principal: number,
    annualRate: number,
    tenureMonths: number,
  ): Array<{
    month: number;
    emiAmount: number;
    principalAmount: number;
    interestAmount: number;
    balance: number;
  }> {
    const emi = this.calculateEMI(principal, annualRate, tenureMonths);
    const monthlyRate = annualRate / 100 / 12;
    
    const schedule = [];
    let balance = principal;
    
    for (let month = 1; month <= tenureMonths; month++) {
      const interestAmount = balance * monthlyRate;
      const principalAmount = emi - interestAmount;
      balance -= principalAmount;
      
      schedule.push({
        month,
        emiAmount: Math.round(emi * 100) / 100,
        principalAmount: Math.round(principalAmount * 100) / 100,
        interestAmount: Math.round(interestAmount * 100) / 100,
        balance: Math.round(Math.max(0, balance) * 100) / 100,
      });
    }
    
    return schedule;
  }

  /**
   * Track defaulters based on overdue payments
   */
  async trackDefaulters(): Promise<Array<{
    loanId: number;
    accountNumber: string;
    memberName: string;
    memberNumber: string;
    principalAmount: number;
    outstandingBalance: number;
    daysPastDue: number;
    maturityDate: Date;
  }>> {
    const currentDate = new Date();
    
    const overdueLoans = await this.loanRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member')
      .where('loan.status = :status', { status: 'ACTIVE' })
      .andWhere('loan.maturityDate < :currentDate', { currentDate })
      .getMany();

    return overdueLoans.map(loan => {
      const daysPastDue = Math.floor(
        (currentDate.getTime() - loan.maturityDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      return {
        loanId: loan.id,
        accountNumber: loan.accountNumber,
        memberName: loan.member.fullName,
        memberNumber: loan.member.memberNumber,
        principalAmount: Number(loan.principalAmount),
        outstandingBalance: Number(loan.outstandingBalance),
        daysPastDue,
        maturityDate: loan.maturityDate,
      };
    });
  }

  /**
   * Automated interest posting - runs daily at midnight
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async automatedInterestPosting(): Promise<void> {
    console.log('Starting automated interest calculation...');
    
    try {
      const results = await this.calculateAllLoansInterest();
      console.log(`Interest calculated for ${results.length} loans`);
      
      // Log summary
      const totalInterest = results.reduce((sum, result) => sum + result.interestAmount, 0);
      console.log(`Total interest calculated: ₹${totalInterest.toFixed(2)}`);
      
    } catch (error) {
      console.error('Error in automated interest posting:', error);
    }
  }

  /**
   * Mark loans as defaulted if overdue by more than specified days
   */
  async markDefaultedLoans(daysPastDue: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysPastDue);

    const result = await this.loanRepository
      .createQueryBuilder()
      .update(LoanAccount)
      .set({ status: 'DEFAULTED' })
      .where('status = :status', { status: 'ACTIVE' })
      .andWhere('maturityDate < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }

  /**
   * Private method to perform actual interest calculation
   */
  private async performInterestCalculation(loan: LoanAccount): Promise<InterestCalculationResult> {
    const currentDate = new Date();
    const lastCalculationDate = loan.lastInterestCalculationDate || loan.disbursementDate;
    
    // Calculate days since last calculation
    const daysDiff = Math.floor(
      (currentDate.getTime() - lastCalculationDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysDiff <= 0) {
      throw new BadRequestException('Interest already calculated for today');
    }

    // Calculate daily interest
    const dailyRate = loan.interestRate / 100 / 365;
    const interestAmount = loan.outstandingBalance * dailyRate * daysDiff;

    // Update loan with calculated interest
    loan.totalInterestAccrued = Number(loan.totalInterestAccrued) + interestAmount;
    loan.lastInterestCalculationDate = currentDate;

    await this.loanRepository.save(loan);

    return {
      loanId: loan.id,
      accountNumber: loan.accountNumber,
      principalAmount: Number(loan.principalAmount),
      interestRate: Number(loan.interestRate),
      daysCalculated: daysDiff,
      interestAmount: Math.round(interestAmount * 100) / 100,
      totalInterestAccrued: Math.round(loan.totalInterestAccrued * 100) / 100,
      calculationDate: currentDate,
    };
  }
}
