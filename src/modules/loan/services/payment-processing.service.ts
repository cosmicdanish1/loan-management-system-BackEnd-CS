import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { LoanAccount, LoanPayment } from '../entities';
import { CreateLoanPaymentDto } from '../dto';

export interface PaymentBreakdown {
  totalAmount: number;
  principalAmount: number;
  interestAmount: number;
  penaltyAmount: number;
  excessAmount: number;
}

export interface PaymentReceipt {
  receiptNumber: string;
  paymentId: number;
  loanAccountNumber: string;
  memberName: string;
  memberNumber: string;
  paymentDate: Date;
  paymentAmount: number;
  paymentBreakdown: PaymentBreakdown;
  balanceAfterPayment: number;
  paymentMethod: string;
  referenceNumber?: string;
  remarks?: string;
  generatedAt: Date;
}

export interface LoanClosure {
  loanId: number;
  accountNumber: string;
  memberName: string;
  closureDate: Date;
  finalPaymentAmount: number;
  totalPrincipalPaid: number;
  totalInterestPaid: number;
  totalPenaltyPaid: number;
  closureType: 'FULL_PAYMENT' | 'FORECLOSURE' | 'SETTLEMENT';
  savingsAmount?: number; // For foreclosure
  penaltyWaived?: number;
}

@Injectable()
export class PaymentProcessingService {
  constructor(
    @InjectRepository(LoanAccount)
    private readonly loanRepository: Repository<LoanAccount>,
    @InjectRepository(LoanPayment)
    private readonly paymentRepository: Repository<LoanPayment>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Process loan payment with automatic breakdown calculation
   */
  async processPayment(
    loanId: number,
    paymentDto: CreateLoanPaymentDto,
  ): Promise<{ payment: LoanPayment; receipt: PaymentReceipt }> {
    return this.dataSource.transaction(async manager => {
      // Get loan with lock to prevent concurrent modifications
      const loan = await manager.findOne(LoanAccount, {
        where: { id: loanId },
        relations: ['member'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!loan) {
        throw new NotFoundException('Loan not found');
      }

      if (loan.status !== 'ACTIVE') {
        throw new BadRequestException('Cannot process payment for inactive loan');
      }

      // Calculate payment breakdown
      const breakdown = this.calculatePaymentBreakdown(paymentDto.amount, loan);

      // Generate payment number and receipt number
      const paymentNumber = await this.generatePaymentNumber();
      const receiptNumber = await this.generateReceiptNumber();

      // Create payment record
      const payment = manager.create(LoanPayment, {
        ...paymentDto,
        loanAccountId: loanId,
        paymentNumber,
        receiptNumber,
        principalAmount: breakdown.principalAmount,
        interestAmount: breakdown.interestAmount,
        penaltyAmount: breakdown.penaltyAmount,
        paymentDate: new Date(paymentDto.paymentDate),
        balanceAfterPayment: loan.outstandingBalance - breakdown.principalAmount,
      });

      // Update loan balance and totals
      loan.outstandingBalance -= breakdown.principalAmount;
      loan.totalPaid += paymentDto.amount;

      // Check if loan should be closed
      if (loan.outstandingBalance <= 0) {
        loan.status = 'CLOSED';
        loan.closureDate = new Date();
        loan.outstandingBalance = 0; // Ensure it's exactly zero
      }

      // Save payment and updated loan
      const savedPayment = await manager.save(LoanPayment, payment);
      await manager.save(LoanAccount, loan);

      // Generate receipt
      const receipt = this.generatePaymentReceipt(savedPayment, loan, breakdown);

      return { payment: savedPayment, receipt };
    });
  }

  /**
   * Process partial payment with custom breakdown
   */
  async processPartialPayment(
    loanId: number,
    paymentDto: CreateLoanPaymentDto & {
      customBreakdown?: {
        principalAmount?: number;
        interestAmount?: number;
        penaltyAmount?: number;
      };
    },
  ): Promise<{ payment: LoanPayment; receipt: PaymentReceipt }> {
    return this.dataSource.transaction(async manager => {
      const loan = await manager.findOne(LoanAccount, {
        where: { id: loanId },
        relations: ['member'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!loan) {
        throw new NotFoundException('Loan not found');
      }

      let breakdown: PaymentBreakdown;

      if (paymentDto.customBreakdown) {
        // Use custom breakdown if provided
        breakdown = this.validateCustomBreakdown(paymentDto.amount, paymentDto.customBreakdown);
      } else {
        // Calculate automatic breakdown
        breakdown = this.calculatePaymentBreakdown(paymentDto.amount, loan);
      }

      // Generate numbers
      const paymentNumber = await this.generatePaymentNumber();
      const receiptNumber = await this.generateReceiptNumber();

      // Create payment
      const payment = manager.create(LoanPayment, {
        ...paymentDto,
        loanAccountId: loanId,
        paymentNumber,
        receiptNumber,
        principalAmount: breakdown.principalAmount,
        interestAmount: breakdown.interestAmount,
        penaltyAmount: breakdown.penaltyAmount,
        paymentDate: new Date(paymentDto.paymentDate),
        balanceAfterPayment: loan.outstandingBalance - breakdown.principalAmount,
      });

      // Update loan
      loan.outstandingBalance -= breakdown.principalAmount;
      loan.totalPaid += paymentDto.amount;

      const savedPayment = await manager.save(LoanPayment, payment);
      await manager.save(LoanAccount, loan);

      const receipt = this.generatePaymentReceipt(savedPayment, loan, breakdown);

      return { payment: savedPayment, receipt };
    });
  }

  /**
   * Process loan foreclosure (early closure)
   */
  async processForeclosure(
    loanId: number,
    foreclosureData: {
      paymentAmount: number;
      paymentMethod: string;
      referenceNumber?: string;
      waivePenalty?: boolean;
      remarks?: string;
    },
  ): Promise<{ closure: LoanClosure; receipt: PaymentReceipt }> {
    return this.dataSource.transaction(async manager => {
      const loan = await manager.findOne(LoanAccount, {
        where: { id: loanId },
        relations: ['member', 'payments'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!loan) {
        throw new NotFoundException('Loan not found');
      }

      if (loan.status !== 'ACTIVE') {
        throw new BadRequestException('Only active loans can be foreclosed');
      }

      // Calculate foreclosure amount
      const foreclosureAmount = this.calculateForeclosureAmount(loan, foreclosureData.waivePenalty);

      if (foreclosureData.paymentAmount < foreclosureAmount.totalAmount) {
        throw new BadRequestException(
          `Insufficient payment amount. Required: ₹${foreclosureAmount.totalAmount}, Provided: ₹${foreclosureData.paymentAmount}`,
        );
      }

      // Create final payment
      const paymentNumber = await this.generatePaymentNumber();
      const receiptNumber = await this.generateReceiptNumber();

      const finalPayment = manager.create(LoanPayment, {
        loanAccountId: loanId,
        paymentNumber,
        receiptNumber,
        amount: foreclosureAmount.totalAmount,
        principalAmount: foreclosureAmount.principalAmount,
        interestAmount: foreclosureAmount.interestAmount,
        penaltyAmount: foreclosureAmount.penaltyAmount,
        paymentDate: new Date(),
        paymentMethod: foreclosureData.paymentMethod,
        referenceNumber: foreclosureData.referenceNumber,
        remarks: `Foreclosure payment. ${foreclosureData.remarks || ''}`.trim(),
        balanceAfterPayment: 0,
      });

      // Close the loan
      loan.status = 'CLOSED';
      loan.closureDate = new Date();
      loan.outstandingBalance = 0;
      loan.totalPaid += foreclosureAmount.totalAmount;

      // Save payment and loan
      const savedPayment = await manager.save(LoanPayment, finalPayment);
      await manager.save(LoanAccount, loan);

      // Calculate totals from all payments
      const totalPrincipalPaid = loan.payments.reduce((sum, p) => sum + Number(p.principalAmount), 0) + foreclosureAmount.principalAmount;
      const totalInterestPaid = loan.payments.reduce((sum, p) => sum + Number(p.interestAmount), 0) + foreclosureAmount.interestAmount;
      const totalPenaltyPaid = loan.payments.reduce((sum, p) => sum + Number(p.penaltyAmount), 0) + foreclosureAmount.penaltyAmount;

      // Create closure record
      const closure: LoanClosure = {
        loanId: loan.id,
        accountNumber: loan.accountNumber,
        memberName: loan.member.fullName,
        closureDate: loan.closureDate,
        finalPaymentAmount: foreclosureAmount.totalAmount,
        totalPrincipalPaid,
        totalInterestPaid,
        totalPenaltyPaid,
        closureType: 'FORECLOSURE',
        savingsAmount: foreclosureData.paymentAmount - foreclosureAmount.totalAmount,
        penaltyWaived: foreclosureData.waivePenalty ? this.calculatePenaltyAmount(loan) : 0,
      };

      // Generate receipt
      const receipt = this.generatePaymentReceipt(savedPayment, loan, foreclosureAmount);

      return { closure, receipt };
    });
  }

  /**
   * Process loan settlement (partial payment to close)
   */
  async processSettlement(
    loanId: number,
    settlementData: {
      settlementAmount: number;
      paymentMethod: string;
      referenceNumber?: string;
      remarks?: string;
      approvedBy: string;
    },
  ): Promise<{ closure: LoanClosure; receipt: PaymentReceipt }> {
    return this.dataSource.transaction(async manager => {
      const loan = await manager.findOne(LoanAccount, {
        where: { id: loanId },
        relations: ['member', 'payments'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!loan) {
        throw new NotFoundException('Loan not found');
      }

      if (loan.status !== 'ACTIVE') {
        throw new BadRequestException('Only active loans can be settled');
      }

      // Create settlement payment
      const paymentNumber = await this.generatePaymentNumber();
      const receiptNumber = await this.generateReceiptNumber();

      const settlementPayment = manager.create(LoanPayment, {
        loanAccountId: loanId,
        paymentNumber,
        receiptNumber,
        amount: settlementData.settlementAmount,
        principalAmount: Math.min(settlementData.settlementAmount, loan.outstandingBalance),
        interestAmount: 0,
        penaltyAmount: 0,
        paymentDate: new Date(),
        paymentMethod: settlementData.paymentMethod,
        referenceNumber: settlementData.referenceNumber,
        remarks: `Settlement payment approved by ${settlementData.approvedBy}. ${settlementData.remarks || ''}`.trim(),
        balanceAfterPayment: 0,
      });

      // Close the loan
      loan.status = 'CLOSED';
      loan.closureDate = new Date();
      const waiveOffAmount = loan.outstandingBalance - settlementData.settlementAmount;
      loan.outstandingBalance = 0;
      loan.totalPaid += settlementData.settlementAmount;

      // Save payment and loan
      const savedPayment = await manager.save(LoanPayment, settlementPayment);
      await manager.save(LoanAccount, loan);

      // Calculate totals
      const totalPrincipalPaid = loan.payments.reduce((sum, p) => sum + Number(p.principalAmount), 0) + settlementData.settlementAmount;
      const totalInterestPaid = loan.payments.reduce((sum, p) => sum + Number(p.interestAmount), 0);
      const totalPenaltyPaid = loan.payments.reduce((sum, p) => sum + Number(p.penaltyAmount), 0);

      // Create closure record
      const closure: LoanClosure = {
        loanId: loan.id,
        accountNumber: loan.accountNumber,
        memberName: loan.member.fullName,
        closureDate: loan.closureDate,
        finalPaymentAmount: settlementData.settlementAmount,
        totalPrincipalPaid,
        totalInterestPaid,
        totalPenaltyPaid,
        closureType: 'SETTLEMENT',
      };

      // Generate receipt
      const breakdown: PaymentBreakdown = {
        totalAmount: settlementData.settlementAmount,
        principalAmount: settlementData.settlementAmount,
        interestAmount: 0,
        penaltyAmount: 0,
        excessAmount: 0,
      };

      const receipt = this.generatePaymentReceipt(savedPayment, loan, breakdown);

      return { closure, receipt };
    });
  }

  /**
   * Get payment receipt by receipt number
   */
  async getPaymentReceipt(receiptNumber: string): Promise<PaymentReceipt> {
    const payment = await this.paymentRepository.findOne({
      where: { receiptNumber },
      relations: ['loanAccount', 'loanAccount.member'],
    });

    if (!payment) {
      throw new NotFoundException('Payment receipt not found');
    }

    const breakdown: PaymentBreakdown = {
      totalAmount: Number(payment.amount),
      principalAmount: Number(payment.principalAmount),
      interestAmount: Number(payment.interestAmount),
      penaltyAmount: Number(payment.penaltyAmount),
      excessAmount: 0,
    };

    return this.generatePaymentReceipt(payment, payment.loanAccount, breakdown);
  }

  /**
   * Calculate outstanding amount for loan closure
   */
  async calculateOutstandingAmount(loanId: number): Promise<{
    principalAmount: number;
    interestAmount: number;
    penaltyAmount: number;
    totalAmount: number;
    asOfDate: Date;
  }> {
    const loan = await this.loanRepository.findOne({
      where: { id: loanId },
    });

    if (!loan) {
      throw new NotFoundException('Loan not found');
    }

    const currentDate = new Date();
    const interestAmount = this.calculateAccruedInterest(loan, currentDate);
    const penaltyAmount = this.calculatePenaltyAmount(loan);

    return {
      principalAmount: Number(loan.outstandingBalance),
      interestAmount,
      penaltyAmount,
      totalAmount: Number(loan.outstandingBalance) + interestAmount + penaltyAmount,
      asOfDate: currentDate,
    };
  }

  // Private helper methods

  private calculatePaymentBreakdown(amount: number, loan: LoanAccount): PaymentBreakdown {
    // Calculate accrued interest
    const accruedInterest = this.calculateAccruedInterest(loan, new Date());
    
    // Calculate penalty if any
    const penaltyAmount = this.calculatePenaltyAmount(loan);
    
    // Allocate payment: penalty first, then interest, then principal
    let remainingAmount = amount;
    
    const allocatedPenalty = Math.min(remainingAmount, penaltyAmount);
    remainingAmount -= allocatedPenalty;
    
    const allocatedInterest = Math.min(remainingAmount, accruedInterest);
    remainingAmount -= allocatedInterest;
    
    const allocatedPrincipal = Math.min(remainingAmount, Number(loan.outstandingBalance));
    const excessAmount = remainingAmount - allocatedPrincipal;

    return {
      totalAmount: amount,
      principalAmount: allocatedPrincipal,
      interestAmount: allocatedInterest,
      penaltyAmount: allocatedPenalty,
      excessAmount,
    };
  }

  private validateCustomBreakdown(
    totalAmount: number,
    customBreakdown: { principalAmount?: number; interestAmount?: number; penaltyAmount?: number },
  ): PaymentBreakdown {
    const principalAmount = customBreakdown.principalAmount || 0;
    const interestAmount = customBreakdown.interestAmount || 0;
    const penaltyAmount = customBreakdown.penaltyAmount || 0;
    
    const allocatedAmount = principalAmount + interestAmount + penaltyAmount;
    
    if (allocatedAmount > totalAmount) {
      throw new BadRequestException('Custom breakdown exceeds total payment amount');
    }

    return {
      totalAmount,
      principalAmount,
      interestAmount,
      penaltyAmount,
      excessAmount: totalAmount - allocatedAmount,
    };
  }

  private calculateForeclosureAmount(loan: LoanAccount, waivePenalty: boolean = false): PaymentBreakdown {
    const currentDate = new Date();
    const interestAmount = this.calculateAccruedInterest(loan, currentDate);
    const penaltyAmount = waivePenalty ? 0 : this.calculatePenaltyAmount(loan);
    const principalAmount = Number(loan.outstandingBalance);

    return {
      totalAmount: principalAmount + interestAmount + penaltyAmount,
      principalAmount,
      interestAmount,
      penaltyAmount,
      excessAmount: 0,
    };
  }

  private calculateAccruedInterest(loan: LoanAccount, asOfDate: Date): number {
    const lastCalculationDate = loan.lastInterestCalculationDate || loan.disbursementDate;
    const daysDiff = Math.floor((asOfDate.getTime() - lastCalculationDate.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysDiff <= 0) return 0;

    const dailyRate = Number(loan.interestRate) / 100 / 365;
    return Number(loan.outstandingBalance) * dailyRate * daysDiff;
  }

  private calculatePenaltyAmount(loan: LoanAccount): number {
    const currentDate = new Date();
    
    if (loan.maturityDate >= currentDate) return 0; // Not overdue
    
    const daysPastDue = Math.floor((currentDate.getTime() - loan.maturityDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Penalty calculation: 2% per month on outstanding balance
    const monthsPastDue = Math.ceil(daysPastDue / 30);
    const penaltyRate = 0.02; // 2% per month
    
    return Number(loan.outstandingBalance) * penaltyRate * monthsPastDue;
  }

  private async generatePaymentNumber(): Promise<string> {
    const prefix = 'PAY';
    const year = new Date().getFullYear().toString().slice(-2);
    
    const lastPayment = await this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.paymentNumber LIKE :pattern', { pattern: `${prefix}${year}%` })
      .orderBy('payment.paymentNumber', 'DESC')
      .getOne();

    let sequence = 1;
    if (lastPayment) {
      const lastSequence = parseInt(lastPayment.paymentNumber.slice(-6));
      sequence = lastSequence + 1;
    }

    return `${prefix}${year}${sequence.toString().padStart(6, '0')}`;
  }

  private async generateReceiptNumber(): Promise<string> {
    const prefix = 'RCP';
    const year = new Date().getFullYear().toString().slice(-2);
    
    const lastReceipt = await this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.receiptNumber LIKE :pattern', { pattern: `${prefix}${year}%` })
      .orderBy('payment.receiptNumber', 'DESC')
      .getOne();

    let sequence = 1;
    if (lastReceipt) {
      const lastSequence = parseInt(lastReceipt.receiptNumber.slice(-6));
      sequence = lastSequence + 1;
    }

    return `${prefix}${year}${sequence.toString().padStart(6, '0')}`;
  }

  private generatePaymentReceipt(
    payment: LoanPayment,
    loan: LoanAccount,
    breakdown: PaymentBreakdown,
  ): PaymentReceipt {
    return {
      receiptNumber: payment.receiptNumber,
      paymentId: payment.id,
      loanAccountNumber: loan.accountNumber,
      memberName: loan.member.fullName,
      memberNumber: loan.member.memberNumber,
      paymentDate: payment.paymentDate,
      paymentAmount: Number(payment.amount),
      paymentBreakdown: breakdown,
      balanceAfterPayment: Number(payment.balanceAfterPayment),
      paymentMethod: payment.paymentMethod,
      referenceNumber: payment.referenceNumber,
      remarks: payment.remarks,
      generatedAt: new Date(),
    };
  }
}
