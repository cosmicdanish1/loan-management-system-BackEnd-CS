import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, ILike, MoreThan, LessThan } from 'typeorm';
import { LoanAccount, LoanPayment } from './entities';
import { Member } from '../member/entities/member.entity';
import {
  CreateLoanDto,
  UpdateLoanDto,
  LoanResponseDto,
  CreateLoanPaymentDto,
  PaymentResponseDto,
} from './dto';

@Injectable()
export class LoanService {
  constructor(
    @InjectRepository(LoanAccount)
    private readonly loanRepository: Repository<LoanAccount>,
    @InjectRepository(LoanPayment)
    private readonly paymentRepository: Repository<LoanPayment>,
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
  ) {}

  /**
   * Create a new loan application
   */
  async create(createLoanDto: CreateLoanDto): Promise<LoanResponseDto> {
    // Validate member exists
    const member = await this.memberRepository.findOne({
      where: { id: createLoanDto.memberId },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Validate loan eligibility
    await this.validateLoanEligibility(createLoanDto.memberId, createLoanDto.principalAmount);

    // Generate unique account number
    const accountNumber = await this.generateAccountNumber();

    // Calculate EMI if tenure is provided
    const emiAmount = this.calculateEMI(
      createLoanDto.principalAmount,
      createLoanDto.interestRate,
      createLoanDto.tenureMonths,
    );

    // Create loan account
    const loanAccount = this.loanRepository.create({
      ...createLoanDto,
      accountNumber,
      outstandingBalance: createLoanDto.principalAmount,
      emiAmount,
      disbursementDate: new Date(createLoanDto.disbursementDate),
      maturityDate: new Date(createLoanDto.maturityDate),
    });

    const savedLoan = await this.loanRepository.save(loanAccount);
    return this.mapToResponseDto(await this.findOne(savedLoan.id));
  }

  /**
   * Get all loans with search and pagination
   */
  async findAll(query: any) {
    const {
      page = 1,
      limit = 10,
      search,
      memberId,
      accountNumber,
      loanType,
      status,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = query;

    const queryBuilder = this.loanRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member')
      .leftJoinAndSelect('loan.payments', 'payments');

    // Apply filters
    if (search) {
      queryBuilder.andWhere(
        '(loan.accountNumber ILIKE :search OR member.firstName ILIKE :search OR member.lastName ILIKE :search OR member.memberNumber ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (memberId) {
      queryBuilder.andWhere('loan.memberId = :memberId', { memberId });
    }

    if (accountNumber) {
      queryBuilder.andWhere('loan.accountNumber ILIKE :accountNumber', {
        accountNumber: `%${accountNumber}%`,
      });
    }

    if (loanType) {
      queryBuilder.andWhere('loan.loanType = :loanType', { loanType });
    }

    if (status) {
      queryBuilder.andWhere('loan.status = :status', { status });
    }

    // Apply sorting
    queryBuilder.orderBy(`loan.${sortBy}`, sortOrder as 'ASC' | 'DESC');

    // Apply pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [loans, total] = await queryBuilder.getManyAndCount();

    return {
      data: loans.map(loan => this.mapToResponseDto(loan)),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get loan statistics
   */
  async getStatistics() {
    const totalLoans = await this.loanRepository.count();
    const activeLoans = await this.loanRepository.count({ where: { status: 'ACTIVE' } });
    const closedLoans = await this.loanRepository.count({ where: { status: 'CLOSED' } });
    const defaultedLoans = await this.loanRepository.count({ where: { status: 'DEFAULTED' } });

    const totalDisbursedResult = await this.loanRepository
      .createQueryBuilder('loan')
      .select('SUM(loan.principalAmount)', 'total')
      .getRawOne();

    const totalOutstandingResult = await this.loanRepository
      .createQueryBuilder('loan')
      .select('SUM(loan.outstandingBalance)', 'total')
      .where('loan.status = :status', { status: 'ACTIVE' })
      .getRawOne();

    return {
      totalLoans,
      activeLoans,
      closedLoans,
      defaultedLoans,
      totalDisbursed: Number(totalDisbursedResult?.total || 0),
      totalOutstanding: Number(totalOutstandingResult?.total || 0),
    };
  }

  /**
   * Get defaulter list
   */
  async getDefaulters(query: any) {
    const { page = 1, limit = 10 } = query;

    const queryBuilder = this.loanRepository
      .createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member')
      .where('loan.status = :status', { status: 'ACTIVE' })
      .andWhere('loan.maturityDate < :currentDate', { currentDate: new Date() });

    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [defaulters, total] = await queryBuilder.getManyAndCount();

    return {
      data: defaulters.map(loan => this.mapToResponseDto(loan)),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Find loan by ID
   */
  async findOne(id: number): Promise<LoanAccount> {
    const loan = await this.loanRepository.findOne({
      where: { id },
      relations: ['member', 'payments'],
    });

    if (!loan) {
      throw new NotFoundException('Loan not found');
    }

    return loan;
  }

  /**
   * Find loan by account number
   */
  async findByAccountNumber(accountNumber: string): Promise<LoanResponseDto> {
    const loan = await this.loanRepository.findOne({
      where: { accountNumber },
      relations: ['member', 'payments'],
    });

    if (!loan) {
      throw new NotFoundException('Loan not found');
    }

    return this.mapToResponseDto(loan);
  }

  /**
   * Find loans by member ID
   */
  async findByMember(memberId: number) {
    const loans = await this.loanRepository.find({
      where: { memberId },
      relations: ['member', 'payments'],
      order: { createdAt: 'DESC' },
    });

    return {
      data: loans.map(loan => this.mapToResponseDto(loan)),
      total: loans.length,
    };
  }

  /**
   * Update loan
   */
  async update(id: number, updateLoanDto: UpdateLoanDto): Promise<LoanResponseDto> {
    const loan = await this.findOne(id);

    // Update loan properties
    Object.assign(loan, updateLoanDto);

    // Recalculate EMI if relevant fields changed
    if (updateLoanDto.principalAmount || updateLoanDto.interestRate || updateLoanDto.tenureMonths) {
      loan.emiAmount = this.calculateEMI(
        loan.principalAmount,
        loan.interestRate,
        loan.tenureMonths,
      );
    }

    const updatedLoan = await this.loanRepository.save(loan);
    return this.mapToResponseDto(updatedLoan);
  }

  /**
   * Disburse loan
   */
  async disburse(id: number): Promise<LoanResponseDto> {
    const loan = await this.findOne(id);

    if (loan.status !== 'ACTIVE') {
      throw new BadRequestException('Only active loans can be disbursed');
    }

    // Update disbursement status (could add more logic here)
    loan.disbursementDate = new Date();
    
    const updatedLoan = await this.loanRepository.save(loan);
    return this.mapToResponseDto(updatedLoan);
  }

  /**
   * Close loan
   */
  async close(id: number): Promise<LoanResponseDto> {
    const loan = await this.findOne(id);

    if (loan.outstandingBalance > 0) {
      throw new BadRequestException('Cannot close loan with outstanding balance');
    }

    loan.status = 'CLOSED';
    loan.closureDate = new Date();

    const updatedLoan = await this.loanRepository.save(loan);
    return this.mapToResponseDto(updatedLoan);
  }

  /**
   * Record loan payment
   */
  async recordPayment(loanId: number, createPaymentDto: CreateLoanPaymentDto): Promise<PaymentResponseDto> {
    const loan = await this.findOne(loanId);

    if (loan.status !== 'ACTIVE') {
      throw new BadRequestException('Cannot record payment for inactive loan');
    }

    // Generate payment number
    const paymentNumber = await this.generatePaymentNumber();

    // Calculate payment breakdown if not provided
    const { principalAmount, interestAmount } = this.calculatePaymentBreakdown(
      createPaymentDto.amount,
      loan,
      createPaymentDto.principalAmount,
      createPaymentDto.interestAmount,
    );

    // Create payment record
    const payment = this.paymentRepository.create({
      ...createPaymentDto,
      loanAccountId: loanId,
      paymentNumber,
      principalAmount,
      interestAmount,
      paymentDate: new Date(createPaymentDto.paymentDate),
      balanceAfterPayment: loan.outstandingBalance - principalAmount,
    });

    // Update loan balance
    loan.outstandingBalance -= principalAmount;
    loan.totalPaid += createPaymentDto.amount;

    // Save both payment and updated loan
    const savedPayment = await this.paymentRepository.save(payment);
    await this.loanRepository.save(loan);

    return this.mapToPaymentResponseDto(savedPayment);
  }

  /**
   * Get payment history
   */
  async getPaymentHistory(loanId: number, query: any) {
    const { page = 1, limit = 10 } = query;

    const queryBuilder = this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.loanAccountId = :loanId', { loanId })
      .orderBy('payment.paymentDate', 'DESC');

    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [payments, total] = await queryBuilder.getManyAndCount();

    return {
      data: payments.map(payment => this.mapToPaymentResponseDto(payment)),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get EMI schedule
   */
  async getEmiSchedule(id: number) {
    const loan = await this.findOne(id);
    
    const schedule = [];
    let balance = loan.principalAmount;
    const monthlyRate = loan.interestRate / 100 / 12;
    
    for (let month = 1; month <= loan.tenureMonths; month++) {
      const interestAmount = balance * monthlyRate;
      const principalAmount = loan.emiAmount - interestAmount;
      balance -= principalAmount;
      
      schedule.push({
        month,
        emiAmount: loan.emiAmount,
        principalAmount: Math.round(principalAmount * 100) / 100,
        interestAmount: Math.round(interestAmount * 100) / 100,
        balance: Math.round(balance * 100) / 100,
      });
    }
    
    return { schedule };
  }

  /**
   * Calculate interest for loan
   */
  async calculateInterest(id: number) {
    const loan = await this.findOne(id);
    
    if (loan.status !== 'ACTIVE') {
      throw new BadRequestException('Interest can only be calculated for active loans');
    }

    const lastCalculationDate = loan.lastInterestCalculationDate || loan.disbursementDate;
    const currentDate = new Date();
    const daysDiff = Math.floor((currentDate.getTime() - lastCalculationDate.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysDiff <= 0) {
      return { message: 'Interest already calculated for today' };
    }

    const dailyRate = loan.interestRate / 100 / 365;
    const interestAmount = loan.outstandingBalance * dailyRate * daysDiff;
    
    loan.totalInterestAccrued += interestAmount;
    loan.lastInterestCalculationDate = currentDate;
    
    await this.loanRepository.save(loan);
    
    return {
      interestAmount: Math.round(interestAmount * 100) / 100,
      days: daysDiff,
      lastCalculationDate: lastCalculationDate,
      currentDate: currentDate,
    };
  }

  /**
   * Update surety information
   */
  async updateSurety(id: number, suretyData: any): Promise<LoanResponseDto> {
    const loan = await this.findOne(id);
    
    Object.assign(loan, suretyData);
    
    const updatedLoan = await this.loanRepository.save(loan);
    return this.mapToResponseDto(updatedLoan);
  }

  /**
   * Soft delete loan
   */
  async remove(id: number): Promise<void> {
    const loan = await this.findOne(id);
    
    if (loan.status === 'ACTIVE' && loan.outstandingBalance > 0) {
      throw new BadRequestException('Cannot delete active loan with outstanding balance');
    }
    
    await this.loanRepository.softDelete(id);
  }

  // Private helper methods

  private async validateLoanEligibility(memberId: number, amount: number): Promise<void> {
    // Check if member has any defaulted loans
    const defaultedLoans = await this.loanRepository.count({
      where: { memberId, status: 'DEFAULTED' },
    });
    
    if (defaultedLoans > 0) {
      throw new BadRequestException('Member has defaulted loans. Cannot approve new loan.');
    }

    // Check total outstanding amount (example: max 5 lakhs)
    const totalOutstandingResult = await this.loanRepository
      .createQueryBuilder('loan')
      .select('SUM(loan.outstandingBalance)', 'total')
      .where('loan.memberId = :memberId', { memberId })
      .andWhere('loan.status = :status', { status: 'ACTIVE' })
      .getRawOne();

    const totalOutstanding = Number(totalOutstandingResult?.total || 0);
    
    if (totalOutstanding + amount > 500000) {
      throw new BadRequestException('Total loan amount exceeds maximum limit of ₹5,00,000');
    }
  }

  private async generateAccountNumber(): Promise<string> {
    const prefix = 'LN';
    const year = new Date().getFullYear().toString().slice(-2);
    
    // Get the last loan account number for this year
    const lastLoan = await this.loanRepository
      .createQueryBuilder('loan')
      .where('loan.accountNumber LIKE :pattern', { pattern: `${prefix}${year}%` })
      .orderBy('loan.accountNumber', 'DESC')
      .getOne();

    let sequence = 1;
    if (lastLoan) {
      const lastSequence = parseInt(lastLoan.accountNumber.slice(-6));
      sequence = lastSequence + 1;
    }

    return `${prefix}${year}${sequence.toString().padStart(6, '0')}`;
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

  private calculateEMI(principal: number, annualRate: number, tenureMonths: number): number {
    const monthlyRate = annualRate / 100 / 12;
    const emi = (principal * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths)) /
                 (Math.pow(1 + monthlyRate, tenureMonths) - 1);
    return Math.round(emi * 100) / 100;
  }

  private calculatePaymentBreakdown(
    amount: number,
    loan: LoanAccount,
    providedPrincipal?: number,
    providedInterest?: number,
  ) {
    if (providedPrincipal && providedInterest) {
      return { principalAmount: providedPrincipal, interestAmount: providedInterest };
    }

    // Simple calculation: interest first, then principal
    const monthlyRate = loan.interestRate / 100 / 12;
    const interestAmount = Math.min(amount, loan.outstandingBalance * monthlyRate);
    const principalAmount = amount - interestAmount;

    return {
      principalAmount: Math.round(principalAmount * 100) / 100,
      interestAmount: Math.round(interestAmount * 100) / 100,
    };
  }

  private mapToResponseDto(loan: LoanAccount): LoanResponseDto {
    return {
      id: loan.id,
      accountNumber: loan.accountNumber,
      member: {
        id: loan.member.id,
        memberNumber: loan.member.memberNumber,
        firstName: loan.member.firstName,
        lastName: loan.member.lastName,
        fullName: loan.member.fullName,
      },
      principalAmount: Number(loan.principalAmount),
      interestRate: Number(loan.interestRate),
      outstandingBalance: Number(loan.outstandingBalance),
      loanType: loan.loanType,
      disbursementDate: loan.disbursementDate,
      maturityDate: loan.maturityDate,
      tenureMonths: loan.tenureMonths,
      emiAmount: loan.emiAmount ? Number(loan.emiAmount) : null,
      purpose: loan.purpose,
      suretyName: loan.suretyName,
      suretyPhone: loan.suretyPhone,
      suretyAddress: loan.suretyAddress,
      status: loan.status,
      totalInterestAccrued: Number(loan.totalInterestAccrued),
      totalPaid: Number(loan.totalPaid),
      lastInterestCalculationDate: loan.lastInterestCalculationDate,
      closureDate: loan.closureDate,
      isOverdue: loan.isOverdue,
      remainingBalance: loan.remainingBalance,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt,
    };
  }

  private mapToPaymentResponseDto(payment: LoanPayment): PaymentResponseDto {
    return {
      id: payment.id,
      paymentNumber: payment.paymentNumber,
      loanAccountId: payment.loanAccountId,
      amount: Number(payment.amount),
      principalAmount: Number(payment.principalAmount),
      interestAmount: Number(payment.interestAmount),
      penaltyAmount: Number(payment.penaltyAmount),
      paymentDate: payment.paymentDate,
      paymentMethod: payment.paymentMethod,
      referenceNumber: payment.referenceNumber,
      remarks: payment.remarks,
      receiptNumber: payment.receiptNumber,
      status: payment.status,
      balanceAfterPayment: Number(payment.balanceAfterPayment),
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }
}
