import { Injectable } from '@nestjs/common';

export interface EMICalculationResult {
  emi: number;
  totalAmount: number;
  totalInterest: number;
  monthlyBreakdown: {
    month: number;
    emi: number;
    principal: number;
    interest: number;
    balance: number;
  }[];
}

export interface CompoundInterestResult {
  maturityAmount: number;
  interestEarned: number;
  effectiveRate: number;
}

export interface AmortizationSchedule {
  installmentNumber: number;
  installmentDate: Date;
  openingBalance: number;
  emi: number;
  principalComponent: number;
  interestComponent: number;
  closingBalance: number;
}

@Injectable()
export class CalculationService {
  /**
   * Calculate EMI (Equated Monthly Installment) for a loan
   * @param principal Principal loan amount
   * @param annualRate Annual interest rate (in percentage)
   * @param tenureMonths Loan tenure in months
   * @returns EMI calculation result with breakdown
   */
  calculateEMI(
    principal: number,
    annualRate: number,
    tenureMonths: number,
  ): EMICalculationResult {
    if (principal <= 0 || annualRate < 0 || tenureMonths <= 0) {
      throw new Error('Invalid input parameters for EMI calculation');
    }

    const monthlyRate = annualRate / (12 * 100);
    
    // Handle zero interest rate case
    if (monthlyRate === 0) {
      const emi = principal / tenureMonths;
      return {
        emi,
        totalAmount: principal,
        totalInterest: 0,
        monthlyBreakdown: this.generateZeroInterestBreakdown(principal, tenureMonths, emi),
      };
    }

    // EMI formula: P * r * (1 + r)^n / ((1 + r)^n - 1)
    const emi = (principal * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths)) /
                (Math.pow(1 + monthlyRate, tenureMonths) - 1);

    const totalAmount = emi * tenureMonths;
    const totalInterest = totalAmount - principal;

    const monthlyBreakdown = this.generateEMIBreakdown(
      principal,
      emi,
      monthlyRate,
      tenureMonths,
    );

    return {
      emi: Math.round(emi * 100) / 100,
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      monthlyBreakdown,
    };
  }

  /**
   * Calculate compound interest
   * @param principal Principal amount
   * @param annualRate Annual interest rate (in percentage)
   * @param timeYears Time period in years
   * @param compoundingFrequency Number of times interest is compounded per year (default: 12 for monthly)
   * @returns Compound interest calculation result
   */
  calculateCompoundInterest(
    principal: number,
    annualRate: number,
    timeYears: number,
    compoundingFrequency: number = 12,
  ): CompoundInterestResult {
    if (principal <= 0 || annualRate < 0 || timeYears < 0 || compoundingFrequency <= 0) {
      throw new Error('Invalid input parameters for compound interest calculation');
    }

    const rate = annualRate / 100;
    const maturityAmount = principal * Math.pow(
      1 + rate / compoundingFrequency,
      compoundingFrequency * timeYears,
    );

    const interestEarned = maturityAmount - principal;
    const effectiveRate = (maturityAmount / principal - 1) * 100;

    return {
      maturityAmount: Math.round(maturityAmount * 100) / 100,
      interestEarned: Math.round(interestEarned * 100) / 100,
      effectiveRate: Math.round(effectiveRate * 10000) / 10000,
    };
  }

  /**
   * Generate loan amortization schedule
   * @param principal Principal loan amount
   * @param annualRate Annual interest rate (in percentage)
   * @param tenureMonths Loan tenure in months
   * @param startDate Loan start date
   * @returns Array of amortization schedule entries
   */
  generateAmortizationSchedule(
    principal: number,
    annualRate: number,
    tenureMonths: number,
    startDate: Date,
  ): AmortizationSchedule[] {
    const emiResult = this.calculateEMI(principal, annualRate, tenureMonths);
    const monthlyRate = annualRate / (12 * 100);
    const schedule: AmortizationSchedule[] = [];

    let balance = principal;
    const currentDate = new Date(startDate);

    for (let i = 1; i <= tenureMonths; i++) {
      const interestComponent = balance * monthlyRate;
      const principalComponent = emiResult.emi - interestComponent;
      const closingBalance = Math.max(0, balance - principalComponent);

      // Calculate installment date (add months)
      const installmentDate = new Date(currentDate);
      installmentDate.setMonth(installmentDate.getMonth() + i);

      schedule.push({
        installmentNumber: i,
        installmentDate,
        openingBalance: Math.round(balance * 100) / 100,
        emi: emiResult.emi,
        principalComponent: Math.round(principalComponent * 100) / 100,
        interestComponent: Math.round(interestComponent * 100) / 100,
        closingBalance: Math.round(closingBalance * 100) / 100,
      });

      balance = closingBalance;
    }

    return schedule;
  }

  /**
   * Calculate simple interest
   * @param principal Principal amount
   * @param rate Interest rate (in percentage)
   * @param time Time period in years
   * @returns Simple interest amount
   */
  calculateSimpleInterest(principal: number, rate: number, time: number): number {
    if (principal <= 0 || rate < 0 || time < 0) {
      throw new Error('Invalid input parameters for simple interest calculation');
    }

    const interest = (principal * rate * time) / 100;
    return Math.round(interest * 100) / 100;
  }

  /**
   * Calculate present value of future amount
   * @param futureValue Future value amount
   * @param discountRate Discount rate (in percentage)
   * @param periods Number of periods
   * @returns Present value
   */
  calculatePresentValue(
    futureValue: number,
    discountRate: number,
    periods: number,
  ): number {
    if (futureValue <= 0 || discountRate < 0 || periods < 0) {
      throw new Error('Invalid input parameters for present value calculation');
    }

    const rate = discountRate / 100;
    const presentValue = futureValue / Math.pow(1 + rate, periods);
    return Math.round(presentValue * 100) / 100;
  }

  /**
   * Calculate future value of present amount
   * @param presentValue Present value amount
   * @param interestRate Interest rate (in percentage)
   * @param periods Number of periods
   * @returns Future value
   */
  calculateFutureValue(
    presentValue: number,
    interestRate: number,
    periods: number,
  ): number {
    if (presentValue <= 0 || interestRate < 0 || periods < 0) {
      throw new Error('Invalid input parameters for future value calculation');
    }

    const rate = interestRate / 100;
    const futureValue = presentValue * Math.pow(1 + rate, periods);
    return Math.round(futureValue * 100) / 100;
  }

  /**
   * Calculate penalty amount for premature withdrawal
   * @param principal Principal amount
   * @param penaltyRate Penalty rate (in percentage)
   * @param daysEarly Number of days before maturity
   * @returns Penalty amount
   */
  calculatePenalty(
    principal: number,
    penaltyRate: number,
    daysEarly: number,
  ): number {
    if (principal <= 0 || penaltyRate < 0 || daysEarly < 0) {
      throw new Error('Invalid input parameters for penalty calculation');
    }

    const penalty = (principal * penaltyRate * daysEarly) / (365 * 100);
    return Math.round(penalty * 100) / 100;
  }

  private generateEMIBreakdown(
    principal: number,
    emi: number,
    monthlyRate: number,
    tenureMonths: number,
  ) {
    const breakdown = [];
    let balance = principal;

    for (let month = 1; month <= tenureMonths; month++) {
      const interestComponent = balance * monthlyRate;
      const principalComponent = emi - interestComponent;
      balance = Math.max(0, balance - principalComponent);

      breakdown.push({
        month,
        emi: Math.round(emi * 100) / 100,
        principal: Math.round(principalComponent * 100) / 100,
        interest: Math.round(interestComponent * 100) / 100,
        balance: Math.round(balance * 100) / 100,
      });
    }

    return breakdown;
  }

  private generateZeroInterestBreakdown(
    principal: number,
    tenureMonths: number,
    emi: number,
  ) {
    const breakdown = [];
    let balance = principal;

    for (let month = 1; month <= tenureMonths; month++) {
      balance = Math.max(0, balance - emi);

      breakdown.push({
        month,
        emi: Math.round(emi * 100) / 100,
        principal: Math.round(emi * 100) / 100,
        interest: 0,
        balance: Math.round(balance * 100) / 100,
      });
    }

    return breakdown;
  }
}
