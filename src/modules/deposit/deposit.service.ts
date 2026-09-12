import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { FixedDeposit, RecurringDeposit, RdInstallment } from './entities';
import { Member } from '../member/entities/member.entity';
import {
  CreateFixedDepositDto,
  UpdateFixedDepositDto,
  CreateRecurringDepositDto,
  UpdateRecurringDepositDto,
  DepositClosureDto,
  DepositMaturityDto,
  CreateRdInstallmentDto,
  PayRdInstallmentDto,
} from './dto';

@Injectable()
export class DepositService {
  constructor(
    @InjectRepository(FixedDeposit)
    private readonly fixedDepositRepository: Repository<FixedDeposit>,
    @InjectRepository(RecurringDeposit)
    private readonly recurringDepositRepository: Repository<RecurringDeposit>,
    @InjectRepository(RdInstallment)
    private readonly rdInstallmentRepository: Repository<RdInstallment>,
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
    private readonly dataSource: DataSource,
  ) { }

  // Fixed Deposit Operations
  async createFixedDeposit(createFixedDepositDto: CreateFixedDepositDto): Promise<FixedDeposit> {
    const { memberId, principalAmount, interestRate, depositDate, tenureMonths, isAutoRenewal } = createFixedDepositDto;

    // Verify member exists
    const member = await this.memberRepository.findOne({ where: { id: memberId } });
    if (!member) {
      throw new NotFoundException(`Member with ID ${memberId} not found`);
    }

    // Generate account number
    const accountNumber = await this.generateAccountNumber('FD');

    // Calculate maturity date and amount
    const startDate = new Date(depositDate);
    const maturityDate = new Date(startDate);
    maturityDate.setMonth(maturityDate.getMonth() + tenureMonths);

    const fixedDeposit = this.fixedDepositRepository.create({
      accountNumber,
      memberId,
      principalAmount,
      interestRate,
      depositDate: startDate,
      maturityDate,
      tenureMonths,
      maturityAmount: 0, // Will be calculated
      isAutoRenewal: isAutoRenewal || false,
      status: 'ACTIVE',
    });

    // Calculate maturity amount
    fixedDeposit.maturityAmount = fixedDeposit.calculateMaturityAmount();

    return await this.fixedDepositRepository.save(fixedDeposit);
  }

  async findAllFixedDeposits(): Promise<FixedDeposit[]> {
    return await this.fixedDepositRepository.find({
      relations: ['member'],
      order: { createdAt: 'DESC' },
    });
  }

  async findFixedDepositById(id: number): Promise<FixedDeposit> {
    const deposit = await this.fixedDepositRepository.findOne({
      where: { id },
      relations: ['member'],
    });

    if (!deposit) {
      throw new NotFoundException(`Fixed deposit with ID ${id} not found`);
    }

    return deposit;
  }

  async findFixedDepositsByMember(memberId: number): Promise<FixedDeposit[]> {
    return await this.fixedDepositRepository.find({
      where: { memberId },
      relations: ['member'],
      order: { createdAt: 'DESC' },
    });
  }

  async findDepositsByMemberNo(memberNo: string): Promise<{ fixedDeposits: FixedDeposit[], recurringDeposits: RecurringDeposit[] }> {
    const member = await this.memberRepository.findOne({ where: { memberNumber: memberNo } });
    if (!member) {
      throw new NotFoundException(`Member with number ${memberNo} not found`);
    }

    const fixedDeposits = await this.fixedDepositRepository.find({
      where: { memberId: member.id },
      order: { createdAt: 'DESC' },
    });

    const recurringDeposits = await this.recurringDepositRepository.find({
      where: { memberId: member.id },
      order: { createdAt: 'DESC' },
    });

    return { fixedDeposits, recurringDeposits };
  }

  async updateFixedDeposit(id: number, updateFixedDepositDto: UpdateFixedDepositDto): Promise<FixedDeposit> {
    const deposit = await this.findFixedDepositById(id);

    // Update allowed fields
    Object.assign(deposit, updateFixedDepositDto);

    // Recalculate maturity amount if relevant fields changed
    if (updateFixedDepositDto.principalAmount || updateFixedDepositDto.interestRate || updateFixedDepositDto.tenureMonths) {
      deposit.maturityAmount = deposit.calculateMaturityAmount();
    }

    return await this.fixedDepositRepository.save(deposit);
  }

  async closeFixedDeposit(id: number, closureDto: DepositClosureDto): Promise<FixedDeposit> {
    const deposit = await this.findFixedDepositById(id);

    if (deposit.status !== 'ACTIVE') {
      throw new BadRequestException('Only active deposits can be closed');
    }

    const closureDate = new Date(closureDto.closureDate);
    const isPremature = closureDate < deposit.maturityDate;

    // Calculate closure amount
    let closureAmount = Number(deposit.principalAmount) + Number(deposit.interestAccrued);
    let penaltyAmount = 0;

    if (isPremature) {
      penaltyAmount = deposit.calculatePenaltyAmount(closureDto.penaltyRate || 1);
      closureAmount -= penaltyAmount;
      deposit.status = 'PREMATURE_CLOSURE';
    } else {
      deposit.status = 'CLOSED';
    }

    deposit.closureDate = closureDate;
    deposit.closureAmount = closureAmount;
    deposit.penaltyAmount = penaltyAmount;
    deposit.closureReason = closureDto.closureReason;

    return await this.fixedDepositRepository.save(deposit);
  }

  async processFixedDepositMaturity(id: number, maturityDto: DepositMaturityDto): Promise<FixedDeposit> {
    const deposit = await this.findFixedDepositById(id);

    if (deposit.status !== 'ACTIVE') {
      throw new BadRequestException('Only active deposits can be processed for maturity');
    }

    const maturityDate = new Date(maturityDto.maturityDate);

    if (maturityDto.renewalAction === 'RENEW' && deposit.isAutoRenewal) {
      // Auto-renew the deposit
      const newTenure = maturityDto.newTenureMonths || deposit.tenureMonths;
      const newMaturityDate = new Date(maturityDate);
      newMaturityDate.setMonth(newMaturityDate.getMonth() + newTenure);

      deposit.principalAmount = deposit.maturityAmount;
      deposit.depositDate = maturityDate;
      deposit.maturityDate = newMaturityDate;
      deposit.tenureMonths = newTenure;
      deposit.maturityAmount = deposit.calculateMaturityAmount();
      deposit.interestAccrued = 0;
    } else {
      // Mark as matured
      deposit.status = 'MATURED';
      deposit.closureDate = maturityDate;
      deposit.closureAmount = deposit.maturityAmount;
    }

    return await this.fixedDepositRepository.save(deposit);
  }

  // Recurring Deposit Operations
  async createRecurringDeposit(createRecurringDepositDto: CreateRecurringDepositDto): Promise<RecurringDeposit> {
    const { memberId, monthlyInstallment, interestRate, startDate, tenureMonths } = createRecurringDepositDto;

    // Verify member exists
    const member = await this.memberRepository.findOne({ where: { id: memberId } });
    if (!member) {
      throw new NotFoundException(`Member with ID ${memberId} not found`);
    }

    // Generate account number
    const accountNumber = await this.generateAccountNumber('RD');

    // Calculate maturity date
    const start = new Date(startDate);
    const maturityDate = new Date(start);
    maturityDate.setMonth(maturityDate.getMonth() + tenureMonths);

    const recurringDeposit = this.recurringDepositRepository.create({
      accountNumber,
      memberId,
      monthlyInstallment,
      interestRate,
      startDate: start,
      maturityDate,
      tenureMonths,
      maturityAmount: 0, // Will be calculated
      status: 'ACTIVE',
      nextDueDate: start,
    });

    // Calculate maturity amount
    recurringDeposit.maturityAmount = recurringDeposit.calculateMaturityAmount();

    const savedRd = await this.recurringDepositRepository.save(recurringDeposit);

    // Generate installment schedule
    await this.generateRdInstallmentSchedule(savedRd);

    return savedRd;
  }

  async findAllRecurringDeposits(): Promise<RecurringDeposit[]> {
    return await this.recurringDepositRepository.find({
      relations: ['member', 'installments'],
      order: { createdAt: 'DESC' },
    });
  }

  async findRecurringDepositById(id: number): Promise<RecurringDeposit> {
    const deposit = await this.recurringDepositRepository.findOne({
      where: { id },
      relations: ['member', 'installments'],
    });

    if (!deposit) {
      throw new NotFoundException(`Recurring deposit with ID ${id} not found`);
    }

    return deposit;
  }

  async findRecurringDepositsByMember(memberId: number): Promise<RecurringDeposit[]> {
    return await this.recurringDepositRepository.find({
      where: { memberId },
      relations: ['member', 'installments'],
      order: { createdAt: 'DESC' },
    });
  }

  async payRdInstallment(installmentId: number, paymentDto: PayRdInstallmentDto): Promise<RdInstallment> {
    const installment = await this.rdInstallmentRepository.findOne({
      where: { id: installmentId },
      relations: ['recurringDeposit'],
    });

    if (!installment) {
      throw new NotFoundException(`Installment with ID ${installmentId} not found`);
    }

    if (installment.status === 'PAID') {
      throw new BadRequestException('Installment is already paid');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Update installment
      installment.paidDate = new Date(paymentDto.paidDate);
      installment.paidAmount = paymentDto.paidAmount;
      installment.paymentMode = paymentDto.paymentMode || 'CASH';
      installment.receiptNumber = paymentDto.receiptNumber;
      installment.remarks = paymentDto.remarks;
      installment.status = 'PAID';

      await queryRunner.manager.save(installment);

      // Update RD account
      const rd = installment.recurringDeposit;
      rd.totalDeposited = Number(rd.totalDeposited) + Number(paymentDto.paidAmount);
      rd.installmentsPaid += 1;
      rd.lastInstallmentDate = new Date(paymentDto.paidDate);
      rd.nextDueDate = rd.calculateNextDueDate();

      await queryRunner.manager.save(rd);

      await queryRunner.commitTransaction();
      return installment;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async closeRecurringDeposit(id: number, closureDto: DepositClosureDto): Promise<RecurringDeposit> {
    const deposit = await this.findRecurringDepositById(id);

    if (deposit.status !== 'ACTIVE') {
      throw new BadRequestException('Only active deposits can be closed');
    }

    const closureDate = new Date(closureDto.closureDate);
    const isPremature = closureDate < deposit.maturityDate;

    // Calculate closure amount
    let closureAmount = Number(deposit.totalDeposited) + Number(deposit.interestAccrued);
    let penaltyAmount = 0;

    if (isPremature) {
      penaltyAmount = deposit.calculatePenalty(closureDto.penaltyRate || 2);
      closureAmount -= penaltyAmount;
    }

    deposit.status = 'CLOSED';
    deposit.closureDate = closureDate;
    deposit.closureAmount = closureAmount;
    deposit.penaltyAmount = penaltyAmount;
    deposit.closureReason = closureDto.closureReason;

    return await this.recurringDepositRepository.save(deposit);
  }

  // Utility methods
  private async generateAccountNumber(type: 'FD' | 'RD'): Promise<string> {
    const prefix = type;
    const year = new Date().getFullYear().toString().slice(-2);
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');

    // Get the count of deposits for this month
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);

    let count: number;
    if (type === 'FD') {
      count = await this.fixedDepositRepository.count({
        where: {
          createdAt: {
            gte: startOfMonth,
            lte: endOfMonth,
          } as any,
        },
      });
    } else {
      count = await this.recurringDepositRepository.count({
        where: {
          createdAt: {
            gte: startOfMonth,
            lte: endOfMonth,
          } as any,
        },
      });
    }

    const sequence = (count + 1).toString().padStart(4, '0');
    return `${prefix}${year}${month}${sequence}`;
  }

  private async generateRdInstallmentSchedule(rd: RecurringDeposit): Promise<void> {
    const installments: Partial<RdInstallment>[] = [];

    for (let i = 1; i <= rd.tenureMonths; i++) {
      const dueDate = new Date(rd.startDate);
      dueDate.setMonth(dueDate.getMonth() + (i - 1));

      installments.push({
        recurringDepositId: rd.id,
        installmentNumber: i,
        amount: rd.monthlyInstallment,
        dueDate,
        status: 'PENDING',
      });
    }

    await this.rdInstallmentRepository.save(installments);
  }

  // Interest calculation methods
  async calculateAndPostInterest(): Promise<void> {
    // Calculate interest for all active deposits
    const activeFixedDeposits = await this.fixedDepositRepository.find({
      where: { status: 'ACTIVE' },
    });

    const activeRecurringDeposits = await this.recurringDepositRepository.find({
      where: { status: 'ACTIVE' },
    });

    for (const fd of activeFixedDeposits) {
      await this.calculateFixedDepositInterest(fd);
    }

    for (const rd of activeRecurringDeposits) {
      await this.calculateRecurringDepositInterest(rd);
    }
  }

  private async calculateFixedDepositInterest(fd: FixedDeposit): Promise<void> {
    const today = new Date();
    const lastCalculationDate = fd.lastInterestCalculationDate || fd.depositDate;

    if (lastCalculationDate >= today) return;

    const daysDiff = Math.floor((today.getTime() - lastCalculationDate.getTime()) / (1000 * 60 * 60 * 24));
    const dailyRate = Number(fd.interestRate) / 100 / 365;
    const interestForPeriod = Number(fd.principalAmount) * dailyRate * daysDiff;

    fd.interestAccrued = Number(fd.interestAccrued) + interestForPeriod;
    fd.lastInterestCalculationDate = today;

    await this.fixedDepositRepository.save(fd);
  }

  private async calculateRecurringDepositInterest(rd: RecurringDeposit): Promise<void> {
    // RD interest calculation is more complex and typically done monthly
    // This is a simplified version
    const today = new Date();
    const monthlyRate = Number(rd.interestRate) / 100 / 12;

    // Calculate interest on the deposited amount
    const interestForMonth = Number(rd.totalDeposited) * monthlyRate;
    rd.interestAccrued = Number(rd.interestAccrued) + interestForMonth;

    await this.recurringDepositRepository.save(rd);
  }
}
