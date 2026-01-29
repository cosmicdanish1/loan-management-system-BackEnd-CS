import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, ILike, MoreThan, LessThan } from 'typeorm';
import { LoanAccount, LoanPayment, DemandMaster } from './entities';
import { LoanMaster } from './entities/loan-master.entity';
import { LoanPending } from './entities/loan-pending.entity';
import { Member } from '../member/entities/member.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import {
  CreateLoanDto,
  UpdateLoanDto,
  LoanResponseDto,
  CreateLoanPaymentDto,
  PaymentResponseDto,
  MemberLoanDetailsDto,
  LoanMasterDetailsDto,
} from './dto';

import { SequenceGeneratorService } from '../shared/services/sequence-generator.service';
import { SystemConfigService } from '../admin/services/system-config.service';

@Injectable()
export class LoanService {
  constructor(
    @InjectRepository(LoanAccount)
    private readonly loanRepository: Repository<LoanAccount>,
    @InjectRepository(LoanPayment)
    private readonly paymentRepository: Repository<LoanPayment>,
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
    @InjectRepository(LoanMaster)
    private readonly loanMasterRepository: Repository<LoanMaster>,
    @InjectRepository(LoanPending)
    private readonly loanPendingRepository: Repository<LoanPending>,
    @InjectRepository(MemberMaster)
    private readonly memberMasterRepository: Repository<MemberMaster>,
    @InjectRepository(DemandMaster)
    private readonly demandMasterRepository: Repository<DemandMaster>,
    private readonly sequenceGenerator: SequenceGeneratorService,
    private readonly systemConfigService: SystemConfigService,
  ) { }

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
   * Get EMI schedule from loan_master with payment status from demand_master
   */
  async getEmiScheduleFromMaster(loanCaseNo: string) {
    // First get the loan details from loan_master
    const loanMaster = await this.loanMasterRepository
      .createQueryBuilder('loan')
      .where('loan.loancaseno = :loanCaseNo', { loanCaseNo })
      .getOne();

    if (!loanMaster) {
      throw new NotFoundException(`Loan case ${loanCaseNo} not found in loan_master`);
    }

    // Get member details
    const member = await this.memberMasterRepository.findOne({
      where: { mbno: loanMaster.mbno },
    });

    if (!member) {
      throw new NotFoundException(`Member ${loanMaster.mbno} not found`);
    }

    // Calculate EMI schedule
    const schedule = [];
    let balance = Number(loanMaster.loan_amt);
    const monthlyRate = Number(loanMaster.rate) / 100 / 12;
    const startDate = new Date(loanMaster.payment_date);

    // Calculate EMI using the installment amount from loan_master or formula
    const emiAmount = Number(loanMaster.instal_amt) ||
      (balance * monthlyRate * Math.pow(1 + monthlyRate, loanMaster.no_of_instal)) /
      (Math.pow(1 + monthlyRate, loanMaster.no_of_instal) - 1);

    // Get payment status from demand_master for this member
    const demandRecords = await this.demandMasterRepository
      .createQueryBuilder('demand')
      .select(['demand.demandForYear', 'demand.demandForMonth'])
      .addSelect(`CASE 
        WHEN demand.${loanMaster.loantype.toLowerCase()}Amount > 0 THEN 'Paid'
        ELSE 'Pending'
      END`, 'paymentStatus')
      .where('demand.mbno = :mbno', { mbno: loanMaster.mbno })
      .orderBy('demand.demandForYear', 'ASC')
      .addOrderBy('demand.demandForMonth', 'ASC')
      .getRawMany();

    // Create a map of payment status by year-month
    const paymentStatusMap = new Map();
    demandRecords.forEach(record => {
      const key = `${record.demand_demandForYear}-${record.demand_demandForMonth}`;
      paymentStatusMap.set(key, record.paymentStatus);
    });

    for (let month = 1; month <= loanMaster.no_of_instal; month++) {
      const interestAmount = balance * monthlyRate;
      const principalAmount = emiAmount - interestAmount;
      balance -= principalAmount;

      // Calculate due date
      const dueDate = new Date(startDate);
      dueDate.setMonth(dueDate.getMonth() + month - 1);

      // Determine payment status
      const yearMonth = `${dueDate.getFullYear()}-${dueDate.getMonth() + 1}`;
      let status = paymentStatusMap.get(yearMonth) || 'Pending';

      // If due date is past and status is pending, mark as overdue
      if (status === 'Pending' && dueDate < new Date()) {
        status = 'Overdue';
      }

      schedule.push({
        month,
        dueDate: dueDate.toISOString().split('T')[0], // YYYY-MM-DD format
        emiAmount: Math.round(emiAmount * 100) / 100,
        principalAmount: Math.round(principalAmount * 100) / 100,
        interestAmount: Math.round(interestAmount * 100) / 100,
        balance: Math.max(0, Math.round(balance * 100) / 100),
        status,
      });
    }

    // Calculate summary statistics
    const paidInstallments = schedule.filter(item => item.status === 'Paid').length;
    const pendingInstallments = schedule.filter(item => item.status === 'Pending').length;
    const overdueInstallments = schedule.filter(item => item.status === 'Overdue').length;

    const totalPaid = schedule
      .filter(item => item.status === 'Paid')
      .reduce((sum, item) => sum + item.emiAmount, 0);

    const totalInterestPaid = schedule
      .filter(item => item.status === 'Paid')
      .reduce((sum, item) => sum + item.interestAmount, 0);

    const totalPrincipalPaid = schedule
      .filter(item => item.status === 'Paid')
      .reduce((sum, item) => sum + item.principalAmount, 0);

    const remainingBalance = Number(loanMaster.loan_amt) - totalPrincipalPaid;
    const completionPercentage = (paidInstallments / loanMaster.no_of_instal) * 100;

    return {
      loanDetails: {
        loanCaseNo: loanMaster.loancaseno,
        memberNumber: loanMaster.mbno,
        memberName: member.fullName,
        loanType: loanMaster.loantype,
        loanAmount: Number(loanMaster.loan_amt),
        rate: Number(loanMaster.rate),
        noOfInstallments: loanMaster.no_of_instal,
        installmentAmount: Number(loanMaster.instal_amt),
        balance: Number(loanMaster.balance),
        purpose: loanMaster.purpose,
        paymentDate: loanMaster.payment_date,
        officeName: `${member.officeno}-${member.dept_name || 'N/A'}`,
        basicPay: Number(member.basic_pay),
      },
      schedule,
      summary: {
        paidInstallments,
        pendingInstallments,
        overdueInstallments,
        totalPaid: Math.round(totalPaid * 100) / 100,
        totalInterestPaid: Math.round(totalInterestPaid * 100) / 100,
        totalPrincipalPaid: Math.round(totalPrincipalPaid * 100) / 100,
        remainingBalance: Math.round(remainingBalance * 100) / 100,
        completionPercentage: Math.round(completionPercentage * 100) / 100,
      },
    };
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

  /**
   * Get member loan details from loan_master table
   * This fetches sanctioned/active loans with member information
   */
  async getMemberLoanFromMaster(loanCaseNo: string): Promise<LoanMasterDetailsDto> {
    const loanMaster = await this.loanMasterRepository
      .createQueryBuilder('loan')
      .where('loan.loancaseno = :loanCaseNo', { loanCaseNo })
      .getOne();

    if (!loanMaster) {
      throw new NotFoundException(`Loan case ${loanCaseNo} not found in loan_master`);
    }

    // Fetch member details
    const member = await this.memberMasterRepository.findOne({
      where: { mbno: loanMaster.mbno },
    });

    if (!member) {
      throw new NotFoundException(`Member ${loanMaster.mbno} not found`);
    }

    // Get office name (you may need to join with division_master table)
    const officeName = `${member.officeno}-${member.dept_name || 'N/A'}`;

    return {
      loanCaseNo: loanMaster.loancaseno,
      memberNumber: loanMaster.mbno,
      loanType: loanMaster.loantype,
      loanAmount: Number(loanMaster.loan_amt),
      paymentDate: loanMaster.payment_date,
      rate: Number(loanMaster.rate),
      noOfInstallments: loanMaster.no_of_instal,
      installmentAmount: Number(loanMaster.instal_amt),
      balance: Number(loanMaster.balance),
      purpose: loanMaster.purpose,
      interestAmount: Number(loanMaster.intt_amount || 0),
      penalRate: Number(loanMaster.penalrate),
      memberName: member.fullName,
      officeName: officeName,
      basicPay: Number(member.basic_pay),
    };
  }

  /**
   * Get member loan details from loan_pending table
   * This fetches pending/applied loans with member information
   */
  async getMemberLoanFromPending(loanCaseNo: string): Promise<MemberLoanDetailsDto> {
    const loanPending = await this.loanPendingRepository
      .createQueryBuilder('loan')
      .where('loan.loancaseno = :loanCaseNo', { loanCaseNo })
      .getOne();

    if (!loanPending) {
      throw new NotFoundException(`Loan case ${loanCaseNo} not found in loan_pending`);
    }

    // Fetch member details
    const member = await this.memberMasterRepository.findOne({
      where: { mbno: loanPending.mbno },
    });

    if (!member) {
      throw new NotFoundException(`Member ${loanPending.mbno} not found`);
    }

    // Get office name
    const officeName = `${member.officeno}-${member.dept_name || 'N/A'}`;

    // Determine status
    let status = 'Pending';
    if (loanPending.flg_paid === 'Y') {
      status = 'Paid';
    } else if (loanPending.flg_sanctioned === 'Y') {
      status = 'Sanctioned';
    }

    return {
      loanCaseNo: loanPending.loancaseno,
      loanType: loanPending.loantype,
      appliedAmount: Number(loanPending.applied_amt),
      applicationDate: loanPending.app_date,
      sanctionedAmount: Number(loanPending.sanctioned_amt),
      sanctionDate: loanPending.sanctioned_date,
      rate: 0, // Rate is not in loan_pending, need to fetch from business rules
      noOfInstallments: loanPending.no_of_instal,
      installmentAmount: 0, // Calculate if needed
      balance: Number(loanPending.sanctioned_amt), // Initial balance
      purpose: loanPending.purpose,
      memberNumber: loanPending.mbno,
      memberName: member.fullName,
      officeName: officeName,
      basicPay: Number(member.basic_pay),
      status: status,
    };
  }

  /**
   * Get all loans for a member from loan_master
   */
  async getMemberLoansFromMaster(memberNumber: string): Promise<LoanMasterDetailsDto[]> {
    const loans = await this.loanMasterRepository
      .createQueryBuilder('loan')
      .where('loan.mbno = :memberNumber', { memberNumber })
      .orderBy('loan.payment_date', 'DESC')
      .getMany();

    const member = await this.memberMasterRepository.findOne({
      where: { mbno: memberNumber },
    });

    if (!member) {
      throw new NotFoundException(`Member ${memberNumber} not found`);
    }

    const officeName = `${member.officeno}-${member.dept_name || 'N/A'}`;

    return loans.map(loan => ({
      loanCaseNo: loan.loancaseno,
      memberNumber: loan.mbno,
      loanType: loan.loantype,
      loanAmount: Number(loan.loan_amt),
      paymentDate: loan.payment_date,
      rate: Number(loan.rate),
      noOfInstallments: loan.no_of_instal,
      installmentAmount: Number(loan.instal_amt),
      balance: Number(loan.balance),
      purpose: loan.purpose,
      interestAmount: Number(loan.intt_amount || 0),
      penalRate: Number(loan.penalrate),
      memberName: member.fullName,
      officeName: officeName,
      basicPay: Number(member.basic_pay),
    }));
  }

  /**
   * Get all pending loans for a member from loan_pending
   */
  async getMemberLoansFromPending(memberNumber: string): Promise<MemberLoanDetailsDto[]> {
    const loans = await this.loanPendingRepository
      .createQueryBuilder('loan')
      .where('loan.mbno = :memberNumber', { memberNumber })
      .orderBy('loan.app_date', 'DESC')
      .getMany();

    const member = await this.memberMasterRepository.findOne({
      where: { mbno: memberNumber },
    });

    if (!member) {
      throw new NotFoundException(`Member ${memberNumber} not found`);
    }

    const officeName = `${member.officeno}-${member.dept_name || 'N/A'}`;

    return loans.map(loan => {
      let status = 'Pending';
      if (loan.flg_paid === 'Y') {
        status = 'Paid';
      } else if (loan.flg_sanctioned === 'Y') {
        status = 'Sanctioned';
      }

      return {
        loanCaseNo: loan.loancaseno,
        loanType: loan.loantype,
        appliedAmount: Number(loan.applied_amt),
        applicationDate: loan.app_date,
        sanctionedAmount: Number(loan.sanctioned_amt),
        sanctionDate: loan.sanctioned_date,
        rate: 0,
        noOfInstallments: loan.no_of_instal,
        installmentAmount: 0,
        balance: Number(loan.sanctioned_amt),
        purpose: loan.purpose,
        memberNumber: loan.mbno,
        memberName: member.fullName,
        officeName: officeName,
        basicPay: Number(member.basic_pay),
        status: status,
      };
    });
  }

  /**
   * Search loans across both loan_master and loan_pending
   */
  async searchMemberLoans(query: {
    memberNumber?: string;
    loanCaseNo?: string;
    loanType?: string;
    status?: 'active' | 'pending' | 'all';
  }) {
    const { memberNumber, loanCaseNo, loanType, status = 'all' } = query;

    const results = {
      activeLoans: [],
      pendingLoans: [],
    };

    // Search in loan_master (active/sanctioned loans)
    if (status === 'active' || status === 'all') {
      const masterQuery = this.loanMasterRepository.createQueryBuilder('loan')
        .leftJoinAndSelect('member_master', 'm', 'm.mbno = loan.mbno');

      if (memberNumber) {
        masterQuery.andWhere('loan.mbno = :memberNumber', { memberNumber });
      }
      if (loanCaseNo) {
        masterQuery.andWhere('loan.loancaseno = :loanCaseNo', { loanCaseNo });
      }
      if (loanType) {
        masterQuery.andWhere('loan.loantype = :loanType', { loanType });
      }

      // We use getRawMany because we are joining with a non-entity table/custom mapping
      const activeLoans = await masterQuery
        .select([
          'loan.loancaseno as loanCaseNo',
          'loan.mbno as memberNumber',
          'loan.loantype as loanType',
          'loan.loan_amt as loanAmount',
          'loan.payment_date as paymentDate',
          'loan.rate as rate',
          'loan.no_of_instal as noOfInstallments',
          'loan.instal_amt as installmentAmount',
          'loan.balance as balance',
          'loan.purpose as purpose',
          'm.f_name', 'm.m_name', 'm.l_name',
          'm.officeno', 'm.dept_name', 'm.basic_pay'
        ])
        .getRawMany();

      results.activeLoans = activeLoans.map(loan => ({
        loanCaseNo: loan.loancaseno,
        memberNumber: loan.membernumber,
        loanType: loan.loantype,
        loanAmount: Number(loan.loanamount),
        paymentDate: loan.paymentdate,
        rate: Number(loan.rate),
        noOfInstallments: loan.noofinstallments,
        installmentAmount: Number(loan.installmentamount),
        balance: Number(loan.balance),
        purpose: loan.purpose,
        memberName: `${loan.f_name || ''} ${loan.m_name || ''} ${loan.l_name || ''}`.replace(/\s+/g, ' ').trim(),
        officeName: `${loan.officeno}-${loan.dept_name || 'N/A'}`,
        basicPay: Number(loan.basic_pay),
      }));
    }

    // Search in loan_pending (pending applications)
    if (status === 'pending' || status === 'all') {
      const pendingQuery = this.loanPendingRepository.createQueryBuilder('loan')
        .leftJoinAndSelect('member_master', 'm', 'm.mbno = loan.mbno');

      if (memberNumber) {
        pendingQuery.andWhere('loan.mbno = :memberNumber', { memberNumber });
      }
      if (loanCaseNo) {
        pendingQuery.andWhere('loan.loancaseno = :loanCaseNo', { loanCaseNo });
      }
      if (loanType) {
        pendingQuery.andWhere('loan.loantype = :loanType', { loanType });
      }

      const pendingLoans = await pendingQuery
        .select([
          'loan.loancaseno as loanCaseNo',
          'loan.loantype as loanType',
          'loan.applied_amt as appliedAmount',
          'loan.app_date as applicationDate',
          'loan.sanctioned_amt as sanctionedAmount',
          'loan.sanctioned_date as sanctionDate',
          'loan.no_of_instal as noOfInstallments',
          'loan.purpose as purpose',
          'loan.mbno as memberNumber',
          'loan.flg_paid as flgPaid',
          'loan.flg_sanctioned as flgSanctioned',
          'm.f_name', 'm.m_name', 'm.l_name',
          'm.officeno', 'm.dept_name', 'm.basic_pay'
        ])
        .getRawMany();

      results.pendingLoans = pendingLoans.map(loan => {
        let loanStatus = 'Pending';
        if (loan.flgpaid === 'Y') {
          loanStatus = 'Paid';
        } else if (loan.flgsanctioned === 'Y') {
          loanStatus = 'Sanctioned';
        }

        return {
          loanCaseNo: loan.loancaseno,
          loanType: loan.loantype,
          appliedAmount: Number(loan.appliedamount),
          applicationDate: loan.applicationdate,
          sanctionedAmount: Number(loan.sanctionedamount),
          sanctionDate: loan.sanctiondate,
          rate: 0,
          noOfInstallments: loan.noofinstallments,
          installmentAmount: 0,
          balance: Number(loan.sanctionedamount),
          purpose: loan.purpose,
          memberNumber: loan.membernumber,
          memberName: `${loan.f_name || ''} ${loan.m_name || ''} ${loan.l_name || ''}`.replace(/\s+/g, ' ').trim(),
          officeName: `${loan.officeno}-${loan.dept_name || 'N/A'}`,
          basicPay: Number(loan.basic_pay),
          status: loanStatus,
        };
      });
    }

    return results;
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

    // Check total outstanding amount against configured limit
    const maxLoanLimit = await this.systemConfigService.getConfigValue('RULE_LOAN_LT_MAX_AMT');

    const totalOutstandingResult = await this.loanRepository
      .createQueryBuilder('loan')
      .select('SUM(loan.outstandingBalance)', 'total')
      .where('loan.memberId = :memberId', { memberId })
      .andWhere('loan.status = :status', { status: 'ACTIVE' })
      .getRawOne();

    const totalOutstanding = Number(totalOutstandingResult?.total || 0);

    if (totalOutstanding + amount > maxLoanLimit) {
      throw new BadRequestException(`Total loan amount exceeds maximum limit of ₹${maxLoanLimit.toLocaleString()}`);
    }
  }

  private async generateAccountNumber(): Promise<string> {
    const prefix = 'LN';
    const year = new Date().getFullYear().toString().slice(-2);
    return await this.sequenceGenerator.generateSequence(`LOAN_ACC_NO_${year}`, `${prefix}${year}`, 6);
  }

  private async generatePaymentNumber(): Promise<string> {
    const prefix = 'PAY';
    const year = new Date().getFullYear().toString().slice(-2);
    return await this.sequenceGenerator.generateSequence(`LOAN_PAY_NO_${year}`, `${prefix}${year}`, 6);
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
