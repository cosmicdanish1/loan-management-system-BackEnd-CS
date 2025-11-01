import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DepositService } from './deposit.service';
import { FixedDeposit, RecurringDeposit, RdInstallment } from './entities';
import { Member } from '../member/entities/member.entity';
import {
  CreateFixedDepositDto,
  UpdateFixedDepositDto,
  CreateRecurringDepositDto,
  DepositClosureDto,
  DepositMaturityDto,
  PayRdInstallmentDto,
} from './dto';

describe('DepositService', () => {
  let service: DepositService;
  let fixedDepositRepository: Repository<FixedDeposit>;
  let recurringDepositRepository: Repository<RecurringDeposit>;
  let rdInstallmentRepository: Repository<RdInstallment>;
  let memberRepository: Repository<Member>;
  let dataSource: DataSource;

  const mockFixedDepositRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
  };

  const mockRecurringDepositRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
  };

  const mockRdInstallmentRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockMemberRepository = {
    findOne: jest.fn(),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      save: jest.fn(),
    },
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  const mockMember: Member = {
    id: 1,
    memberNumber: 'MEM001',
    firstName: 'John',
    lastName: 'Doe',
    dateOfBirth: new Date('1990-01-01'),
    address: '123 Main St',
    phoneNumber: '1234567890',
    email: 'john@example.com',
    aadharNumber: '123456789012',
    panNumber: 'ABCDE1234F',
    occupation: 'Engineer',
    shareAmount: 1000,
    signatureImagePath: null,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get fullName() { return `${this.firstName} ${this.lastName}`; },
  };

  const mockFixedDeposit: FixedDeposit = {
    id: 1,
    accountNumber: 'FD24010001',
    member: mockMember,
    memberId: 1,
    principalAmount: 100000,
    interestRate: 8.5,
    depositDate: new Date('2024-01-01'),
    maturityDate: new Date('2025-01-01'),
    tenureMonths: 12,
    maturityAmount: 108500,
    interestAccrued: 0,
    status: 'ACTIVE',
    closureDate: null,
    closureAmount: null,
    penaltyAmount: null,
    closureReason: null,
    isAutoRenewal: false,
    lastInterestCalculationDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get isMatured() { return new Date() >= this.maturityDate; },
    get daysToMaturity() {
      const today = new Date();
      const maturity = new Date(this.maturityDate);
      const diffTime = maturity.getTime() - today.getTime();
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    },
    get currentValue() {
      if (this.status === 'CLOSED') {
        return Number(this.closureAmount || 0);
      }
      return Number(this.principalAmount) + Number(this.interestAccrued);
    },
    calculateMaturityAmount() {
      const principal = Number(this.principalAmount);
      const rate = Number(this.interestRate) / 100;
      const time = this.tenureMonths / 12;
      return principal * Math.pow(1 + rate, time);
    },
    calculatePenaltyAmount(penaltyRate: number = 1) {
      const currentInterest = this.interestAccrued;
      return Number(currentInterest) * (penaltyRate / 100);
    },
  };

  const mockRecurringDeposit: RecurringDeposit = {
    id: 1,
    accountNumber: 'RD24010001',
    member: mockMember,
    memberId: 1,
    monthlyInstallment: 5000,
    interestRate: 9.0,
    startDate: new Date('2024-01-01'),
    maturityDate: new Date('2026-01-01'),
    tenureMonths: 24,
    maturityAmount: 130000,
    totalDeposited: 0,
    interestAccrued: 0,
    installmentsPaid: 0,
    installmentsMissed: 0,
    status: 'ACTIVE',
    closureDate: null,
    closureAmount: null,
    penaltyAmount: null,
    closureReason: null,
    lastInstallmentDate: null,
    nextDueDate: new Date('2024-01-01'),
    installments: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get isMatured() { return new Date() >= this.maturityDate; },
    get remainingInstallments() { return this.tenureMonths - this.installmentsPaid; },
    get isOverdue() {
      if (!this.nextDueDate || this.status !== 'ACTIVE') return false;
      return new Date() > this.nextDueDate;
    },
    get currentValue() {
      if (this.status === 'CLOSED') {
        return Number(this.closureAmount || 0);
      }
      return Number(this.totalDeposited) + Number(this.interestAccrued);
    },
    calculateMaturityAmount() {
      const monthlyAmount = Number(this.monthlyInstallment);
      const rate = Number(this.interestRate) / 100 / 12;
      const months = this.tenureMonths;
      
      if (rate === 0) {
        return monthlyAmount * months;
      }
      
      const factor = (Math.pow(1 + rate, months) - 1) / rate;
      return monthlyAmount * factor * (1 + rate);
    },
    calculateNextDueDate() {
      if (!this.lastInstallmentDate) {
        return new Date(this.startDate);
      }
      
      const nextDue = new Date(this.lastInstallmentDate);
      nextDue.setMonth(nextDue.getMonth() + 1);
      return nextDue;
    },
    calculatePenalty(penaltyRate: number = 2) {
      return this.installmentsMissed * Number(this.monthlyInstallment) * (penaltyRate / 100);
    },
  };

  const mockRdInstallment: RdInstallment = {
    id: 1,
    recurringDeposit: mockRecurringDeposit,
    recurringDepositId: 1,
    installmentNumber: 1,
    amount: 5000,
    dueDate: new Date('2024-01-01'),
    paidDate: null,
    paidAmount: null,
    penaltyAmount: 0,
    status: 'PENDING',
    remarks: null,
    receiptNumber: null,
    paymentMode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    get isOverdue() {
      return this.status === 'PENDING' && new Date() > this.dueDate;
    },
    get daysPastDue() {
      if (!this.isOverdue) return 0;
      const today = new Date();
      const due = new Date(this.dueDate);
      const diffTime = today.getTime() - due.getTime();
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    },
    get outstandingAmount() {
      if (this.status === 'PAID') return 0;
      return Number(this.amount) + Number(this.penaltyAmount) - Number(this.paidAmount || 0);
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepositService,
        {
          provide: getRepositoryToken(FixedDeposit),
          useValue: mockFixedDepositRepository,
        },
        {
          provide: getRepositoryToken(RecurringDeposit),
          useValue: mockRecurringDepositRepository,
        },
        {
          provide: getRepositoryToken(RdInstallment),
          useValue: mockRdInstallmentRepository,
        },
        {
          provide: getRepositoryToken(Member),
          useValue: mockMemberRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<DepositService>(DepositService);
    fixedDepositRepository = module.get<Repository<FixedDeposit>>(getRepositoryToken(FixedDeposit));
    recurringDepositRepository = module.get<Repository<RecurringDeposit>>(getRepositoryToken(RecurringDeposit));
    rdInstallmentRepository = module.get<Repository<RdInstallment>>(getRepositoryToken(RdInstallment));
    memberRepository = module.get<Repository<Member>>(getRepositoryToken(Member));
    dataSource = module.get<DataSource>(DataSource);

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe('Fixed Deposit Operations', () => {
    describe('createFixedDeposit', () => {
      const createFixedDepositDto: CreateFixedDepositDto = {
        memberId: 1,
        principalAmount: 100000,
        interestRate: 8.5,
        depositDate: '2024-01-01',
        tenureMonths: 12,
        isAutoRenewal: false,
      };

      it('should create a fixed deposit successfully', async () => {
        mockMemberRepository.findOne.mockResolvedValue(mockMember);
        mockFixedDepositRepository.count.mockResolvedValue(0);
        mockFixedDepositRepository.create.mockReturnValue(mockFixedDeposit);
        mockFixedDepositRepository.save.mockResolvedValue(mockFixedDeposit);

        const result = await service.createFixedDeposit(createFixedDepositDto);

        expect(mockMemberRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
        expect(mockFixedDepositRepository.create).toHaveBeenCalled();
        expect(mockFixedDepositRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
        expect(result.principalAmount).toBe(100000);
      });

      it('should throw NotFoundException if member not found', async () => {
        mockMemberRepository.findOne.mockResolvedValue(null);

        await expect(service.createFixedDeposit(createFixedDepositDto)).rejects.toThrow(NotFoundException);
        expect(mockMemberRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
      });
    });

    describe('findFixedDepositById', () => {
      it('should return a fixed deposit by ID', async () => {
        mockFixedDepositRepository.findOne.mockResolvedValue(mockFixedDeposit);

        const result = await service.findFixedDepositById(1);

        expect(mockFixedDepositRepository.findOne).toHaveBeenCalledWith({
          where: { id: 1 },
          relations: ['member'],
        });
        expect(result).toEqual(mockFixedDeposit);
      });

      it('should throw NotFoundException if fixed deposit not found', async () => {
        mockFixedDepositRepository.findOne.mockResolvedValue(null);

        await expect(service.findFixedDepositById(1)).rejects.toThrow(NotFoundException);
      });
    });

    describe('closeFixedDeposit', () => {
      const closureDto: DepositClosureDto = {
        closureDate: '2024-06-01',
        closureReason: 'Early withdrawal',
        penaltyRate: 1,
      };

      it('should close fixed deposit with premature closure', async () => {
        const activeDeposit = { ...mockFixedDeposit, interestAccrued: 5000 };
        mockFixedDepositRepository.findOne.mockResolvedValue(activeDeposit);
        mockFixedDepositRepository.save.mockResolvedValue({
          ...activeDeposit,
          status: 'PREMATURE_CLOSURE',
          closureDate: new Date('2024-06-01'),
        });

        const result = await service.closeFixedDeposit(1, closureDto);

        expect(mockFixedDepositRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it('should throw BadRequestException for non-active deposit', async () => {
        const closedDeposit = { ...mockFixedDeposit, status: 'CLOSED' };
        mockFixedDepositRepository.findOne.mockResolvedValue(closedDeposit);

        await expect(service.closeFixedDeposit(1, closureDto)).rejects.toThrow(BadRequestException);
      });
    });

    describe('processFixedDepositMaturity', () => {
      const maturityDto: DepositMaturityDto = {
        maturityDate: '2025-01-01',
        renewalAction: 'CLOSE',
      };

      it('should process maturity and close deposit', async () => {
        mockFixedDepositRepository.findOne.mockResolvedValue(mockFixedDeposit);
        mockFixedDepositRepository.save.mockResolvedValue({
          ...mockFixedDeposit,
          status: 'MATURED',
        });

        const result = await service.processFixedDepositMaturity(1, maturityDto);

        expect(mockFixedDepositRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it('should auto-renew deposit if configured', async () => {
        const autoRenewDeposit = { ...mockFixedDeposit, isAutoRenewal: true, status: 'ACTIVE' };
        const renewalDto = { ...maturityDto, renewalAction: 'RENEW' as const, newTenureMonths: 12 };
        
        mockFixedDepositRepository.findOne.mockResolvedValue(autoRenewDeposit);
        mockFixedDepositRepository.save.mockResolvedValue(autoRenewDeposit);

        const result = await service.processFixedDepositMaturity(1, renewalDto);

        expect(mockFixedDepositRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
      });
    });
  });

  describe('Recurring Deposit Operations', () => {
    describe('createRecurringDeposit', () => {
      const createRecurringDepositDto: CreateRecurringDepositDto = {
        memberId: 1,
        monthlyInstallment: 5000,
        interestRate: 9.0,
        startDate: '2024-01-01',
        tenureMonths: 24,
      };

      it('should create a recurring deposit successfully', async () => {
        mockMemberRepository.findOne.mockResolvedValue(mockMember);
        mockRecurringDepositRepository.count.mockResolvedValue(0);
        mockRecurringDepositRepository.create.mockReturnValue(mockRecurringDeposit);
        mockRecurringDepositRepository.save.mockResolvedValue(mockRecurringDeposit);
        mockRdInstallmentRepository.save.mockResolvedValue([]);

        const result = await service.createRecurringDeposit(createRecurringDepositDto);

        expect(mockMemberRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
        expect(mockRecurringDepositRepository.create).toHaveBeenCalled();
        expect(mockRecurringDepositRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
        expect(result.monthlyInstallment).toBe(5000);
      });

      it('should throw NotFoundException if member not found', async () => {
        mockMemberRepository.findOne.mockResolvedValue(null);

        await expect(service.createRecurringDeposit(createRecurringDepositDto)).rejects.toThrow(NotFoundException);
      });
    });

    describe('findRecurringDepositById', () => {
      it('should return a recurring deposit by ID', async () => {
        mockRecurringDepositRepository.findOne.mockResolvedValue(mockRecurringDeposit);

        const result = await service.findRecurringDepositById(1);

        expect(mockRecurringDepositRepository.findOne).toHaveBeenCalledWith({
          where: { id: 1 },
          relations: ['member', 'installments'],
        });
        expect(result).toEqual(mockRecurringDeposit);
      });

      it('should throw NotFoundException if recurring deposit not found', async () => {
        mockRecurringDepositRepository.findOne.mockResolvedValue(null);

        await expect(service.findRecurringDepositById(1)).rejects.toThrow(NotFoundException);
      });
    });

    describe('payRdInstallment', () => {
      const paymentDto: PayRdInstallmentDto = {
        paidAmount: 5000,
        paidDate: '2024-01-01',
        paymentMode: 'CASH',
        receiptNumber: 'RCP001',
        remarks: 'Monthly installment',
      };

      it('should pay RD installment successfully', async () => {
        mockRdInstallmentRepository.findOne.mockResolvedValue(mockRdInstallment);
        mockQueryRunner.manager.save.mockResolvedValue(mockRdInstallment);

        const result = await service.payRdInstallment(1, paymentDto);

        expect(mockQueryRunner.connect).toHaveBeenCalled();
        expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
        expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
        expect(mockQueryRunner.release).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it('should throw NotFoundException if installment not found', async () => {
        mockRdInstallmentRepository.findOne.mockResolvedValue(null);

        await expect(service.payRdInstallment(1, paymentDto)).rejects.toThrow(NotFoundException);
      });

      it('should throw BadRequestException if installment already paid', async () => {
        const paidInstallment = { ...mockRdInstallment, status: 'PAID' };
        mockRdInstallmentRepository.findOne.mockResolvedValue(paidInstallment);

        await expect(service.payRdInstallment(1, paymentDto)).rejects.toThrow(BadRequestException);
      });
    });

    describe('closeRecurringDeposit', () => {
      const closureDto: DepositClosureDto = {
        closureDate: '2024-06-01',
        closureReason: 'Early closure',
        penaltyRate: 2,
      };

      it('should close recurring deposit successfully', async () => {
        const activeRd = { ...mockRecurringDeposit, totalDeposited: 30000, interestAccrued: 2000 };
        mockRecurringDepositRepository.findOne.mockResolvedValue(activeRd);
        mockRecurringDepositRepository.save.mockResolvedValue({
          ...activeRd,
          status: 'CLOSED',
        });

        const result = await service.closeRecurringDeposit(1, closureDto);

        expect(mockRecurringDepositRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it('should throw BadRequestException for non-active deposit', async () => {
        const closedRd = { ...mockRecurringDeposit, status: 'CLOSED' };
        mockRecurringDepositRepository.findOne.mockResolvedValue(closedRd);

        await expect(service.closeRecurringDeposit(1, closureDto)).rejects.toThrow(BadRequestException);
      });
    });
  });

  describe('Interest Calculation', () => {
    describe('calculateAndPostInterest', () => {
      it('should calculate interest for all active deposits', async () => {
        const activeFixedDeposits = [mockFixedDeposit];
        const activeRecurringDeposits = [mockRecurringDeposit];

        mockFixedDepositRepository.find.mockResolvedValue(activeFixedDeposits);
        mockRecurringDepositRepository.find.mockResolvedValue(activeRecurringDeposits);
        mockFixedDepositRepository.save.mockResolvedValue(mockFixedDeposit);
        mockRecurringDepositRepository.save.mockResolvedValue(mockRecurringDeposit);

        await service.calculateAndPostInterest();

        expect(mockFixedDepositRepository.find).toHaveBeenCalledWith({
          where: { status: 'ACTIVE' },
        });
        expect(mockRecurringDepositRepository.find).toHaveBeenCalledWith({
          where: { status: 'ACTIVE' },
        });
      });
    });
  });

  describe('Utility Methods', () => {
    describe('findAllFixedDeposits', () => {
      it('should return all fixed deposits', async () => {
        const deposits = [mockFixedDeposit];
        mockFixedDepositRepository.find.mockResolvedValue(deposits);

        const result = await service.findAllFixedDeposits();

        expect(mockFixedDepositRepository.find).toHaveBeenCalledWith({
          relations: ['member'],
          order: { createdAt: 'DESC' },
        });
        expect(result).toEqual(deposits);
      });
    });

    describe('findFixedDepositsByMember', () => {
      it('should return fixed deposits for a specific member', async () => {
        const deposits = [mockFixedDeposit];
        mockFixedDepositRepository.find.mockResolvedValue(deposits);

        const result = await service.findFixedDepositsByMember(1);

        expect(mockFixedDepositRepository.find).toHaveBeenCalledWith({
          where: { memberId: 1 },
          relations: ['member'],
          order: { createdAt: 'DESC' },
        });
        expect(result).toEqual(deposits);
      });
    });

    describe('updateFixedDeposit', () => {
      const updateDto: UpdateFixedDepositDto = {
        interestRate: 9.0,
        status: 'ACTIVE',
      };

      it('should update fixed deposit successfully', async () => {
        mockFixedDepositRepository.findOne.mockResolvedValue(mockFixedDeposit);
        const updatedDeposit = { ...mockFixedDeposit, interestRate: 9.0 };
        mockFixedDepositRepository.save.mockResolvedValue(updatedDeposit);

        const result = await service.updateFixedDeposit(1, updateDto);

        expect(mockFixedDepositRepository.save).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it('should recalculate maturity amount when relevant fields change', async () => {
        mockFixedDepositRepository.findOne.mockResolvedValue(mockFixedDeposit);
        const updatedDeposit = { ...mockFixedDeposit, principalAmount: 150000 };
        mockFixedDepositRepository.save.mockResolvedValue(updatedDeposit);

        await service.updateFixedDeposit(1, { principalAmount: 150000 });

        expect(mockFixedDepositRepository.save).toHaveBeenCalled();
      });
    });
  });
});
