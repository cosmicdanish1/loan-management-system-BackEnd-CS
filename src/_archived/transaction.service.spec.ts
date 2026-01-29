import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TransactionService } from './transaction.service';
import { Transaction, Voucher } from './entities';
import { Member } from '../member/entities/member.entity';
import {
  CreateTransactionDto,
  CreateVoucherDto,
  TransactionType,
  VoucherType,
  TransactionQueryDto,
  ReverseTransactionDto,
} from './dto';

describe('TransactionService', () => {
  let service: TransactionService;
  let transactionRepository: Repository<Transaction>;
  let voucherRepository: Repository<Voucher>;
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const mockMember: Partial<Member> = {
    id: 1,
    memberNumber: 'M001',
    firstName: 'John',
    lastName: 'Doe',
    fullName: 'John Doe',
  };

  const mockTransaction: Partial<Transaction> = {
    id: 1,
    transactionNumber: 'TXN2024000001',
    transactionDate: new Date('2024-01-15'),
    transactionType: 'PAYMENT',
    amount: 5000,
    description: 'Test payment',
    debitAccount: 'CASH_AC',
    creditAccount: 'EXPENSE_AC',
    memberId: 1,
    member: mockMember as Member,
    status: 'POSTED',
    canBeReversed: true,
    isReversed: false,
  };

  const mockVoucher: Partial<Voucher> = {
    id: 1,
    voucherNumber: 'PY2024001',
    voucherDate: new Date('2024-01-15'),
    voucherType: 'PAYMENT',
    totalAmount: 5000,
    description: 'Test voucher',
    memberId: 1,
    member: mockMember as Member,
    status: 'ACTIVE',
    canBeCancelled: true,
    isCancelled: false,
    isAuthorized: false,
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn(),
      })),
    },
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getCount: jest.fn(),
    getMany: jest.fn(),
  };

  const mockTransactionRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(() => mockQueryBuilder),
  };

  const mockVoucherRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn(() => mockQueryRunner),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepository,
        },
        {
          provide: getRepositoryToken(Voucher),
          useValue: mockVoucherRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
    transactionRepository = module.get<Repository<Transaction>>(
      getRepositoryToken(Transaction),
    );
    voucherRepository = module.get<Repository<Voucher>>(
      getRepositoryToken(Voucher),
    );
    dataSource = module.get<DataSource>(DataSource);
    queryRunner = mockQueryRunner as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createTransaction', () => {
    const createTransactionDto: CreateTransactionDto = {
      transactionType: TransactionType.PAYMENT,
      amount: 5000,
      description: 'Test payment',
      debitAccount: 'CASH_AC',
      creditAccount: 'EXPENSE_AC',
      memberId: 1,
    };

    it('should create a transaction successfully', async () => {
      mockQueryRunner.manager.create.mockReturnValue(mockTransaction);
      mockQueryRunner.manager.save.mockResolvedValue(mockTransaction);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      const result = await service.createTransaction(createTransactionDto);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.transactionType).toBe('PAYMENT');
      expect(result.amount).toBe(5000);
    });

    it('should validate double-entry bookkeeping - same debit and credit accounts', async () => {
      const invalidDto = {
        ...createTransactionDto,
        debitAccount: 'CASH_AC',
        creditAccount: 'CASH_AC',
      };

      await expect(service.createTransaction(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should validate positive amount', async () => {
      const invalidDto = {
        ...createTransactionDto,
        amount: -1000,
      };

      await expect(service.createTransaction(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should rollback transaction on error', async () => {
      mockQueryRunner.manager.save.mockRejectedValue(new Error('Database error'));

      await expect(service.createTransaction(createTransactionDto)).rejects.toThrow();
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe('createVoucher', () => {
    const createVoucherDto: CreateVoucherDto = {
      voucherType: VoucherType.PAYMENT,
      description: 'Test voucher',
      memberId: 1,
      transactions: [
        {
          description: 'Test transaction',
          debitAccount: 'CASH_AC',
          creditAccount: 'EXPENSE_AC',
          amount: 5000,
        },
      ],
    };

    it('should create a voucher with transactions successfully', async () => {
      const mockVoucherWithTransactions = {
        ...mockVoucher,
        transactions: [{ ...mockTransaction, transactionDate: new Date('2024-01-15') }],
      };

      mockQueryRunner.manager.create
        .mockReturnValueOnce(mockVoucher)
        .mockReturnValueOnce(mockTransaction);
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(mockVoucher)
        .mockResolvedValueOnce(mockTransaction);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);
      mockVoucherRepository.findOne.mockResolvedValue(mockVoucherWithTransactions);

      const result = await service.createVoucher(createVoucherDto);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.voucherType).toBe('PAYMENT');
      expect(result.totalAmount).toBe(5000);
    });

    it('should validate voucher has transactions', async () => {
      const invalidDto = {
        ...createVoucherDto,
        transactions: [],
      };

      await expect(service.createVoucher(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should validate transaction amounts are positive', async () => {
      const invalidDto = {
        ...createVoucherDto,
        transactions: [
          {
            description: 'Invalid transaction',
            debitAccount: 'CASH_AC',
            creditAccount: 'EXPENSE_AC',
            amount: -1000,
          },
        ],
      };

      await expect(service.createVoucher(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('findAllTransactions', () => {
    const queryDto: TransactionQueryDto = {
      page: 1,
      limit: 10,
      transactionType: TransactionType.PAYMENT,
      sortBy: 'transactionDate',
      sortOrder: 'DESC',
    };

    it('should return paginated transactions with filters', async () => {
      mockQueryBuilder.getCount.mockResolvedValue(1);
      mockQueryBuilder.getMany.mockResolvedValue([mockTransaction]);

      const result = await service.findAllTransactions(queryDto);

      expect(result).toBeDefined();
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
    });

    it('should apply search filter', async () => {
      const queryWithSearch = { ...queryDto, search: 'test' };
      mockQueryBuilder.getCount.mockResolvedValue(0);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.findAllTransactions(queryWithSearch);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.objectContaining({ search: '%test%' }),
      );
      expect(result.data).toHaveLength(0);
    });
  });

  describe('findTransactionById', () => {
    it('should return transaction by ID', async () => {
      mockTransactionRepository.findOne.mockResolvedValue(mockTransaction);

      const result = await service.findTransactionById(1);

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
      expect(mockTransactionRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        relations: ['member'],
      });
    });

    it('should throw NotFoundException when transaction not found', async () => {
      mockTransactionRepository.findOne.mockResolvedValue(null);

      await expect(service.findTransactionById(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reverseTransaction', () => {
    const reverseDto: ReverseTransactionDto = {
      reason: 'Incorrect amount',
    };

    it('should reverse a transaction successfully', async () => {
      const reversibleTransaction = {
        ...mockTransaction,
        canBeReversed: true,
        status: 'POSTED',
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(reversibleTransaction);
      mockQueryRunner.manager.create.mockReturnValue({
        ...mockTransaction,
        id: 2,
        transactionNumber: 'TXN2024000002',
      });
      mockQueryRunner.manager.save.mockResolvedValue(reversibleTransaction);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      const result = await service.reverseTransaction(1, reverseDto);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.status).toBe('REVERSED');
    });

    it('should throw NotFoundException when transaction not found', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.reverseTransaction(999, reverseDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw BadRequestException when transaction cannot be reversed', async () => {
      const nonReversibleTransaction = {
        ...mockTransaction,
        canBeReversed: false,
        status: 'REVERSED',
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(nonReversibleTransaction);

      await expect(service.reverseTransaction(1, reverseDto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('Double-Entry Validation', () => {
    it('should validate that debit and credit accounts are different', () => {
      const invalidDto: CreateTransactionDto = {
        transactionType: TransactionType.PAYMENT,
        amount: 1000,
        description: 'Test',
        debitAccount: 'CASH_AC',
        creditAccount: 'CASH_AC', // Same as debit
      };

      expect(() => service['validateDoubleEntry'](invalidDto)).toThrow(
        BadRequestException,
      );
    });

    it('should validate that amount is positive', () => {
      const invalidDto: CreateTransactionDto = {
        transactionType: TransactionType.PAYMENT,
        amount: -1000, // Negative amount
        description: 'Test',
        debitAccount: 'CASH_AC',
        creditAccount: 'EXPENSE_AC',
      };

      expect(() => service['validateDoubleEntry'](invalidDto)).toThrow(
        BadRequestException,
      );
    });

    it('should pass validation for valid double-entry data', () => {
      const validDto: CreateTransactionDto = {
        transactionType: TransactionType.PAYMENT,
        amount: 1000,
        description: 'Test',
        debitAccount: 'CASH_AC',
        creditAccount: 'EXPENSE_AC',
      };

      expect(() => service['validateDoubleEntry'](validDto)).not.toThrow();
    });
  });

  describe('Transaction Number Generation', () => {
    it('should generate unique transaction numbers', async () => {
      // Mock no existing transactions
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValueOnce(null);

      const transactionNumber = await service['generateTransactionNumber'](queryRunner);
      const currentYear = new Date().getFullYear();
      
      expect(transactionNumber).toBe(`TXN${currentYear}000001`);
    });

    it('should increment transaction numbers correctly', async () => {
      const currentYear = new Date().getFullYear();
      const lastTransaction = {
        transactionNumber: `TXN${currentYear}000005`,
      };
      
      // Reset the mock to return the last transaction for this specific test
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValueOnce(lastTransaction);

      const transactionNumber = await service['generateTransactionNumber'](queryRunner);
      
      expect(transactionNumber).toBe(`TXN${currentYear}000006`);
    });
  });
});
