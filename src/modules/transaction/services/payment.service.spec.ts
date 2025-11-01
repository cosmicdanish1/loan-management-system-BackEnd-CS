import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { Transaction, Voucher } from '../entities';
import { Member } from '../../member/entities/member.entity';

describe('PaymentService', () => {
  let service: PaymentService;
  let transactionRepository: Repository<Transaction>;
  let voucherRepository: Repository<Voucher>;
  let memberRepository: Repository<Member>;
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const mockMember: Partial<Member> = {
    id: 1,
    memberNumber: 'M001',
    firstName: 'John',
    lastName: 'Doe',
    fullName: 'John Doe',
    shareAmount: 10000,
  };

  const mockVoucher: Partial<Voucher> = {
    id: 1,
    voucherNumber: 'PY2024001',
    voucherDate: new Date('2024-01-15'),
    voucherType: 'PAYMENT',
    totalAmount: 5000,
    description: 'Test payment voucher',
    status: 'ACTIVE',
  };

  const mockTransaction: Partial<Transaction> = {
    id: 1,
    transactionNumber: 'TXN2024000001',
    transactionDate: new Date('2024-01-15'),
    transactionType: 'PAYMENT',
    amount: 5000,
    description: 'Test payment',
    debitAccount: 'EXPENSE_AC',
    creditAccount: 'CASH_AC',
    status: 'POSTED',
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
      increment: jest.fn(),
      decrement: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn(),
      })),
    },
  };

  const mockTransactionRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const mockVoucherRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const mockMemberRepository = {
    findOne: jest.fn(),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn(() => mockQueryRunner),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepository,
        },
        {
          provide: getRepositoryToken(Voucher),
          useValue: mockVoucherRepository,
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

    service = module.get<PaymentService>(PaymentService);
    transactionRepository = module.get<Repository<Transaction>>(
      getRepositoryToken(Transaction),
    );
    voucherRepository = module.get<Repository<Voucher>>(
      getRepositoryToken(Voucher),
    );
    memberRepository = module.get<Repository<Member>>(
      getRepositoryToken(Member),
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

  describe('createPaymentVoucher', () => {
    const paymentDto = {
      memberId: 1,
      payeeName: 'John Doe',
      amount: 5000,
      description: 'Office rent payment',
      paymentMethod: 'CASH' as const,
      accountCode: 'CASH_AC',
      expenseAccount: 'RENT_EXPENSE',
    };

    it('should create a payment voucher successfully', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(mockMember);
      mockQueryRunner.manager.create
        .mockReturnValueOnce(mockVoucher)
        .mockReturnValueOnce(mockTransaction);
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(mockVoucher)
        .mockResolvedValueOnce(mockTransaction);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      const result = await service.createPaymentVoucher(paymentDto);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.voucher).toBeDefined();
      expect(result.transaction).toBeDefined();
      expect(result.receiptNumber).toBeDefined();
    });

    it('should create payment voucher without member', async () => {
      const paymentWithoutMember = { ...paymentDto, memberId: undefined };
      
      mockQueryRunner.manager.create
        .mockReturnValueOnce(mockVoucher)
        .mockReturnValueOnce(mockTransaction);
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(mockVoucher)
        .mockResolvedValueOnce(mockTransaction);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      const result = await service.createPaymentVoucher(paymentWithoutMember);

      expect(result).toBeDefined();
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when member not found', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.createPaymentVoucher(paymentDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should rollback on error', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(mockMember);
      mockQueryRunner.manager.save.mockRejectedValue(new Error('Database error'));

      await expect(service.createPaymentVoucher(paymentDto)).rejects.toThrow();
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe('createReceiptVoucher', () => {
    const receiptDto = {
      memberId: 1,
      amount: 5000,
      description: 'Loan EMI payment',
      receiptMethod: 'CASH' as const,
      accountCode: 'CASH_AC',
      incomeAccount: 'LOAN_INTEREST_INCOME',
    };

    it('should create a receipt voucher successfully', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(mockMember);
      mockQueryRunner.manager.create
        .mockReturnValueOnce(mockVoucher)
        .mockReturnValueOnce(mockTransaction);
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(mockVoucher)
        .mockResolvedValueOnce(mockTransaction);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      const result = await service.createReceiptVoucher(receiptDto);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.voucher).toBeDefined();
      expect(result.transaction).toBeDefined();
      expect(result.receiptNumber).toBeDefined();
    });

    it('should throw NotFoundException when member not found', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.createReceiptVoucher(receiptDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('createMemberBalanceTransfer', () => {
    const transferDto = {
      fromMemberId: 1,
      toMemberId: 2,
      amount: 2000,
      description: 'Share transfer',
      transferType: 'SHARE_TRANSFER' as const,
    };

    const mockToMember: Partial<Member> = {
      id: 2,
      memberNumber: 'M002',
      firstName: 'Jane',
      lastName: 'Smith',
      fullName: 'Jane Smith',
      shareAmount: 5000,
    };

    it('should create a member balance transfer successfully', async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(mockMember) // fromMember
        .mockResolvedValueOnce(mockToMember); // toMember
      mockQueryRunner.manager.create
        .mockReturnValueOnce(mockVoucher)
        .mockReturnValueOnce(mockTransaction) // debit transaction
        .mockReturnValueOnce(mockTransaction); // credit transaction
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(mockVoucher)
        .mockResolvedValueOnce([mockTransaction, mockTransaction]);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      const result = await service.createMemberBalanceTransfer(transferDto);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.voucher).toBeDefined();
      expect(result.debitTransaction).toBeDefined();
      expect(result.creditTransaction).toBeDefined();
      expect(result.transferNumber).toBeDefined();
    });

    it('should throw NotFoundException when fromMember not found', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValueOnce(null);

      await expect(service.createMemberBalanceTransfer(transferDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw NotFoundException when toMember not found', async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(mockMember)
        .mockResolvedValueOnce(null);

      await expect(service.createMemberBalanceTransfer(transferDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should update member share amounts for share transfer', async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(mockMember)
        .mockResolvedValueOnce(mockToMember);
      mockQueryRunner.manager.create
        .mockReturnValueOnce(mockVoucher)
        .mockReturnValueOnce(mockTransaction)
        .mockReturnValueOnce(mockTransaction);
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(mockVoucher)
        .mockResolvedValueOnce([mockTransaction, mockTransaction]);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      await service.createMemberBalanceTransfer(transferDto);

      expect(mockQueryRunner.manager.decrement).toHaveBeenCalledWith(
        Member,
        { id: 1 },
        'shareAmount',
        2000,
      );
      expect(mockQueryRunner.manager.increment).toHaveBeenCalledWith(
        Member,
        { id: 2 },
        'shareAmount',
        2000,
      );
    });
  });

  describe('rollbackTransaction', () => {
    const rollbackReason = 'Incorrect amount posted';

    it('should rollback a transaction successfully', async () => {
      const transactionToRollback = {
        ...mockTransaction,
        status: 'POSTED',
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(transactionToRollback);
      mockQueryRunner.manager.create.mockReturnValue({
        ...mockTransaction,
        id: 2,
        transactionNumber: 'TXN2024000002',
      });
      mockQueryRunner.manager.save.mockResolvedValue(transactionToRollback);
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValue(null);

      const result = await service.rollbackTransaction(1, rollbackReason);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.originalTransaction).toBeDefined();
      expect(result.rollbackTransaction).toBeDefined();
    });

    it('should throw NotFoundException when transaction not found', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.rollbackTransaction(999, rollbackReason)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw BadRequestException when transaction is not posted', async () => {
      const nonPostedTransaction = {
        ...mockTransaction,
        status: 'CANCELLED',
      };

      mockQueryRunner.manager.findOne.mockResolvedValue(nonPostedTransaction);

      await expect(service.rollbackTransaction(1, rollbackReason)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('Voucher Number Generation', () => {
    it('should generate unique voucher numbers', async () => {
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValueOnce(null);

      const voucherNumber = await service['generateVoucherNumber'](queryRunner, 'PAYMENT');
      const currentYear = new Date().getFullYear();
      
      expect(voucherNumber).toBe(`PY${currentYear}0001`);
    });

    it('should increment voucher numbers correctly', async () => {
      const currentYear = new Date().getFullYear();
      const lastVoucher = {
        voucherNumber: `PY${currentYear}0005`,
      };
      
      mockQueryRunner.manager.createQueryBuilder().getOne.mockResolvedValueOnce(lastVoucher);

      const voucherNumber = await service['generateVoucherNumber'](queryRunner, 'PAYMENT');
      
      expect(voucherNumber).toBe(`PY${currentYear}0006`);
    });

    it('should generate different prefixes for different voucher types', async () => {
      mockQueryRunner.manager.createQueryBuilder().getOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      const currentYear = new Date().getFullYear();

      const paymentNumber = await service['generateVoucherNumber'](queryRunner, 'PAYMENT');
      const receiptNumber = await service['generateVoucherNumber'](queryRunner, 'RECEIPT');
      const journalNumber = await service['generateVoucherNumber'](queryRunner, 'JOURNAL');

      expect(paymentNumber).toBe(`PY${currentYear}0001`);
      expect(receiptNumber).toBe(`RE${currentYear}0001`);
      expect(journalNumber).toBe(`JO${currentYear}0001`);
    });
  });

  describe('Account Code Generation', () => {
    it('should generate correct account codes for different transfer types', () => {
      const shareAccount = service['getAccountCodeForTransferType']('SHARE_TRANSFER', 1);
      const depositAccount = service['getAccountCodeForTransferType']('DEPOSIT_TRANSFER', 1);
      const loanAccount = service['getAccountCodeForTransferType']('LOAN_ADJUSTMENT', 1);
      const generalAccount = service['getAccountCodeForTransferType']('OTHER', 1);

      expect(shareAccount).toBe('MEMBER_SHARE_1');
      expect(depositAccount).toBe('MEMBER_DEPOSIT_1');
      expect(loanAccount).toBe('MEMBER_LOAN_1');
      expect(generalAccount).toBe('MEMBER_GENERAL_1');
    });
  });
});
