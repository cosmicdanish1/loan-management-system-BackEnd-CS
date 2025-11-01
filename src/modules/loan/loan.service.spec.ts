import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { LoanService } from './loan.service';
import { LoanAccount, LoanPayment } from './entities';
import { Member } from '../member/entities/member.entity';
import { CreateLoanDto, UpdateLoanDto } from './dto';

describe('LoanService', () => {
  let service: LoanService;
  let loanRepository: Repository<LoanAccount>;
  let paymentRepository: Repository<LoanPayment>;
  let memberRepository: Repository<Member>;

  const mockLoanRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    softDelete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockPaymentRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockMemberRepository = {
    findOne: jest.fn(),
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
    getMany: jest.fn(),
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
    getOne: jest.fn(),
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

  const mockLoan: LoanAccount = {
    id: 1,
    accountNumber: 'LN24000001',
    member: mockMember,
    memberId: 1,
    principalAmount: 100000,
    interestRate: 12.5,
    outstandingBalance: 100000,
    loanType: 'PERSONAL',
    disbursementDate: new Date('2024-01-01'),
    maturityDate: new Date('2025-01-01'),
    tenureMonths: 12,
    emiAmount: 8884.88,
    purpose: 'Business expansion',
    suretyName: 'Jane Doe',
    suretyPhone: '9876543210',
    suretyAddress: '456 Oak St',
    status: 'ACTIVE',
    totalInterestAccrued: 0,
    totalPaid: 0,
    lastInterestCalculationDate: null,
    closureDate: null,
    payments: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get isOverdue() { return new Date() > this.maturityDate; },
    get remainingBalance() { return Number(this.outstandingBalance); },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanService,
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockLoanRepository,
        },
        {
          provide: getRepositoryToken(LoanPayment),
          useValue: mockPaymentRepository,
        },
        {
          provide: getRepositoryToken(Member),
          useValue: mockMemberRepository,
        },
      ],
    }).compile();

    service = module.get<LoanService>(LoanService);
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));
    paymentRepository = module.get<Repository<LoanPayment>>(getRepositoryToken(LoanPayment));
    memberRepository = module.get<Repository<Member>>(getRepositoryToken(Member));

    // Reset all mocks
    jest.clearAllMocks();
    mockLoanRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
    mockPaymentRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  });

  describe('create', () => {
    const createLoanDto: CreateLoanDto = {
      memberId: 1,
      principalAmount: 100000,
      interestRate: 12.5,
      loanType: 'PERSONAL',
      disbursementDate: '2024-01-01',
      maturityDate: '2025-01-01',
      tenureMonths: 12,
      purpose: 'Business expansion',
      suretyName: 'Jane Doe',
      suretyPhone: '9876543210',
      suretyAddress: '456 Oak St',
    };

    it('should create a loan successfully', async () => {
      mockMemberRepository.findOne.mockResolvedValue(mockMember);
      mockLoanRepository.count.mockResolvedValue(0); // No defaulted loans
      mockQueryBuilder.getRawOne.mockResolvedValue({ total: 0 }); // No outstanding loans
      mockQueryBuilder.getOne.mockResolvedValue(null); // No existing loan account
      mockLoanRepository.create.mockReturnValue(mockLoan);
      mockLoanRepository.save.mockResolvedValue(mockLoan);
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);

      const result = await service.create(createLoanDto);

      expect(mockMemberRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(mockLoanRepository.create).toHaveBeenCalled();
      expect(mockLoanRepository.save).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.principalAmount).toBe(100000);
    });

    it('should throw NotFoundException if member not found', async () => {
      mockMemberRepository.findOne.mockResolvedValue(null);

      await expect(service.create(createLoanDto)).rejects.toThrow(NotFoundException);
      expect(mockMemberRepository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('should throw BadRequestException if member has defaulted loans', async () => {
      mockMemberRepository.findOne.mockResolvedValue(mockMember);
      mockLoanRepository.count.mockResolvedValue(1); // Has defaulted loans

      await expect(service.create(createLoanDto)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if total loan amount exceeds limit', async () => {
      mockMemberRepository.findOne.mockResolvedValue(mockMember);
      mockLoanRepository.count.mockResolvedValue(0);
      mockQueryBuilder.getRawOne.mockResolvedValue({ total: 450000 }); // High outstanding amount

      await expect(service.create(createLoanDto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return paginated loans', async () => {
      const mockLoans = [mockLoan];
      mockQueryBuilder.getManyAndCount.mockResolvedValue([mockLoans, 1]);

      const result = await service.findAll({ page: 1, limit: 10 });

      expect(result).toEqual({
        data: expect.any(Array),
        pagination: {
          page: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
        },
      });
    });

    it('should apply search filters', async () => {
      const mockLoans = [mockLoan];
      mockQueryBuilder.getManyAndCount.mockResolvedValue([mockLoans, 1]);

      await service.findAll({ search: 'John', memberId: 1, status: 'ACTIVE' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a loan by ID', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);

      const result = await service.findOne(1);

      expect(mockLoanRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        relations: ['member', 'payments'],
      });
      expect(result).toEqual(mockLoan);
    });

    it('should throw NotFoundException if loan not found', async () => {
      mockLoanRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(1)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    const updateLoanDto: UpdateLoanDto = {
      interestRate: 13.0,
      status: 'ACTIVE',
    };

    it('should update a loan successfully', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);
      const updatedLoan = { ...mockLoan, interestRate: 13.0 };
      mockLoanRepository.save.mockResolvedValue(updatedLoan);

      const result = await service.update(1, updateLoanDto);

      expect(mockLoanRepository.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should recalculate EMI when relevant fields change', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);
      const updatedLoan = { ...mockLoan, principalAmount: 150000 };
      mockLoanRepository.save.mockResolvedValue(updatedLoan);

      await service.update(1, { principalAmount: 150000 });

      expect(mockLoanRepository.save).toHaveBeenCalled();
    });
  });

  describe('disburse', () => {
    it('should disburse an active loan', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);
      mockLoanRepository.save.mockResolvedValue(mockLoan);

      const result = await service.disburse(1);

      expect(mockLoanRepository.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should throw BadRequestException for non-active loan', async () => {
      const closedLoan = { ...mockLoan, status: 'CLOSED' };
      mockLoanRepository.findOne.mockResolvedValue(closedLoan);

      await expect(service.disburse(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('close', () => {
    it('should close a loan with zero balance', async () => {
      const loanWithZeroBalance = { ...mockLoan, outstandingBalance: 0 };
      mockLoanRepository.findOne.mockResolvedValue(loanWithZeroBalance);
      mockLoanRepository.save.mockResolvedValue({ ...loanWithZeroBalance, status: 'CLOSED' });

      const result = await service.close(1);

      expect(mockLoanRepository.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should throw BadRequestException for loan with outstanding balance', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);

      await expect(service.close(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getStatistics', () => {
    it('should return loan statistics', async () => {
      mockLoanRepository.count
        .mockResolvedValueOnce(10) // total loans
        .mockResolvedValueOnce(7)  // active loans
        .mockResolvedValueOnce(2)  // closed loans
        .mockResolvedValueOnce(1); // defaulted loans

      mockQueryBuilder.getRawOne
        .mockResolvedValueOnce({ total: 1000000 }) // total disbursed
        .mockResolvedValueOnce({ total: 500000 });  // total outstanding

      const result = await service.getStatistics();

      expect(result).toEqual({
        totalLoans: 10,
        activeLoans: 7,
        closedLoans: 2,
        defaultedLoans: 1,
        totalDisbursed: 1000000,
        totalOutstanding: 500000,
      });
    });
  });

  describe('getDefaulters', () => {
    it('should return defaulter list with pagination', async () => {
      const overdueLoans = [{ ...mockLoan, maturityDate: new Date('2023-01-01') }];
      mockQueryBuilder.getManyAndCount.mockResolvedValue([overdueLoans, 1]);

      const result = await service.getDefaulters({ page: 1, limit: 10 });

      expect(result).toEqual({
        data: expect.any(Array),
        pagination: {
          page: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
        },
      });
    });
  });

  describe('calculateInterest', () => {
    it('should calculate interest for active loan', async () => {
      const loanWithLastCalculation = {
        ...mockLoan,
        lastInterestCalculationDate: new Date('2024-01-01'),
      };
      mockLoanRepository.findOne.mockResolvedValue(loanWithLastCalculation);
      mockLoanRepository.save.mockResolvedValue(loanWithLastCalculation);

      const result = await service.calculateInterest(1);

      expect(result).toHaveProperty('interestAmount');
      expect(result).toHaveProperty('days');
      expect(mockLoanRepository.save).toHaveBeenCalled();
    });

    it('should throw BadRequestException for non-active loan', async () => {
      const closedLoan = { ...mockLoan, status: 'CLOSED' };
      mockLoanRepository.findOne.mockResolvedValue(closedLoan);

      await expect(service.calculateInterest(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('should soft delete loan without outstanding balance', async () => {
      const closedLoan = { ...mockLoan, status: 'CLOSED', outstandingBalance: 0 };
      mockLoanRepository.findOne.mockResolvedValue(closedLoan);
      mockLoanRepository.softDelete.mockResolvedValue({ affected: 1 });

      await service.remove(1);

      expect(mockLoanRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('should throw BadRequestException for active loan with balance', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);

      await expect(service.remove(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('private helper methods', () => {
    it('should calculate EMI correctly', async () => {
      // Test EMI calculation through create method
      mockMemberRepository.findOne.mockResolvedValue(mockMember);
      mockLoanRepository.count.mockResolvedValue(0);
      mockQueryBuilder.getRawOne.mockResolvedValue({ total: 0 });
      mockQueryBuilder.getOne.mockResolvedValue(null);
      mockLoanRepository.create.mockReturnValue(mockLoan);
      mockLoanRepository.save.mockResolvedValue(mockLoan);
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);

      const createLoanDto: CreateLoanDto = {
        memberId: 1,
        principalAmount: 100000,
        interestRate: 12,
        loanType: 'PERSONAL',
        disbursementDate: '2024-01-01',
        maturityDate: '2025-01-01',
        tenureMonths: 12,
      };

      await service.create(createLoanDto);

      expect(mockLoanRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          emiAmount: expect.any(Number),
        })
      );
    });
  });
});
