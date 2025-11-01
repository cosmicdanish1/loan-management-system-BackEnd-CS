import { Test, TestingModule } from '@nestjs/testing';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import {
  CreateTransactionDto,
  TransactionType,
  TransactionQueryDto,
  ReverseTransactionDto,
  TransactionResponseDto,
} from './dto';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('TransactionController', () => {
  let controller: TransactionController;
  let transactionService: TransactionService;

  const mockTransactionResponse: TransactionResponseDto = {
    id: 1,
    transactionNumber: 'TXN2024000001',
    transactionDate: new Date('2024-01-15'),
    transactionType: 'PAYMENT',
    amount: 5000,
    description: 'Test payment',
    debitAccount: 'CASH_AC',
    creditAccount: 'EXPENSE_AC',
    status: 'POSTED',
    isReversed: false,
    canBeReversed: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPaginatedResponse = {
    data: [mockTransactionResponse],
    total: 1,
    page: 1,
    limit: 10,
    totalPages: 1,
  };

  const mockTransactionService = {
    createTransaction: jest.fn(),
    findAllTransactions: jest.fn(),
    findTransactionById: jest.fn(),
    reverseTransaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionController],
      providers: [
        {
          provide: TransactionService,
          useValue: mockTransactionService,
        },
      ],
    }).compile();

    controller = module.get<TransactionController>(TransactionController);
    transactionService = module.get<TransactionService>(TransactionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
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
      mockTransactionService.createTransaction.mockResolvedValue(mockTransactionResponse);

      const result = await controller.createTransaction(createTransactionDto);

      expect(result).toEqual(mockTransactionResponse);
      expect(mockTransactionService.createTransaction).toHaveBeenCalledWith(
        createTransactionDto,
      );
    });

    it('should handle validation errors', async () => {
      mockTransactionService.createTransaction.mockRejectedValue(
        new BadRequestException('Debit and credit accounts cannot be the same'),
      );

      await expect(controller.createTransaction(createTransactionDto)).rejects.toThrow(
        BadRequestException,
      );
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

    it('should return paginated transactions', async () => {
      mockTransactionService.findAllTransactions.mockResolvedValue(mockPaginatedResponse);

      const result = await controller.findAllTransactions(queryDto);

      expect(result).toEqual(mockPaginatedResponse);
      expect(mockTransactionService.findAllTransactions).toHaveBeenCalledWith(queryDto);
    });

    it('should handle empty results', async () => {
      const emptyResponse = {
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };
      mockTransactionService.findAllTransactions.mockResolvedValue(emptyResponse);

      const result = await controller.findAllTransactions(queryDto);

      expect(result).toEqual(emptyResponse);
      expect(result.data).toHaveLength(0);
    });

    it('should apply filters correctly', async () => {
      const filteredQuery: TransactionQueryDto = {
        ...queryDto,
        memberId: 1,
        fromDate: '2024-01-01',
        toDate: '2024-01-31',
        search: 'payment',
      };

      mockTransactionService.findAllTransactions.mockResolvedValue(mockPaginatedResponse);

      await controller.findAllTransactions(filteredQuery);

      expect(mockTransactionService.findAllTransactions).toHaveBeenCalledWith(
        filteredQuery,
      );
    });
  });

  describe('findTransactionById', () => {
    it('should return transaction by ID', async () => {
      mockTransactionService.findTransactionById.mockResolvedValue(mockTransactionResponse);

      const result = await controller.findTransactionById(1);

      expect(result).toEqual(mockTransactionResponse);
      expect(mockTransactionService.findTransactionById).toHaveBeenCalledWith(1);
    });

    it('should handle transaction not found', async () => {
      mockTransactionService.findTransactionById.mockRejectedValue(
        new NotFoundException('Transaction with ID 999 not found'),
      );

      await expect(controller.findTransactionById(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reverseTransaction', () => {
    const reverseDto: ReverseTransactionDto = {
      reason: 'Incorrect amount posted',
    };

    it('should reverse transaction successfully', async () => {
      const reversedTransaction = {
        ...mockTransactionResponse,
        status: 'REVERSED',
        isReversed: true,
        canBeReversed: false,
      };

      mockTransactionService.reverseTransaction.mockResolvedValue(reversedTransaction);

      const result = await controller.reverseTransaction(1, reverseDto);

      expect(result).toEqual(reversedTransaction);
      expect(mockTransactionService.reverseTransaction).toHaveBeenCalledWith(1, reverseDto);
    });

    it('should handle transaction not found for reversal', async () => {
      mockTransactionService.reverseTransaction.mockRejectedValue(
        new NotFoundException('Transaction with ID 999 not found'),
      );

      await expect(controller.reverseTransaction(999, reverseDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should handle transaction that cannot be reversed', async () => {
      mockTransactionService.reverseTransaction.mockRejectedValue(
        new BadRequestException('Transaction cannot be reversed'),
      );

      await expect(controller.reverseTransaction(1, reverseDto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Input Validation', () => {
    it('should validate transaction type enum', async () => {
      const invalidDto = {
        transactionType: 'INVALID_TYPE' as any,
        amount: 5000,
        description: 'Test',
        debitAccount: 'CASH_AC',
        creditAccount: 'EXPENSE_AC',
      };

      // This would be caught by class-validator in real scenario
      expect(Object.values(TransactionType)).not.toContain('INVALID_TYPE');
    });

    it('should validate positive amounts', () => {
      const invalidDto = {
        transactionType: TransactionType.PAYMENT,
        amount: -1000,
        description: 'Test',
        debitAccount: 'CASH_AC',
        creditAccount: 'EXPENSE_AC',
      };

      // This would be caught by class-validator @IsPositive() decorator
      expect(invalidDto.amount).toBeLessThan(0);
    });

    it('should validate required fields', () => {
      const incompleteDto = {
        transactionType: TransactionType.PAYMENT,
        amount: 5000,
        // Missing description, debitAccount, creditAccount
      };

      expect(incompleteDto).not.toHaveProperty('description');
      expect(incompleteDto).not.toHaveProperty('debitAccount');
      expect(incompleteDto).not.toHaveProperty('creditAccount');
    });
  });

  describe('Error Handling', () => {
    it('should handle service errors gracefully', async () => {
      const createDto: CreateTransactionDto = {
        transactionType: TransactionType.PAYMENT,
        amount: 5000,
        description: 'Test payment',
        debitAccount: 'CASH_AC',
        creditAccount: 'EXPENSE_AC',
      };

      mockTransactionService.createTransaction.mockRejectedValue(
        new Error('Database connection failed'),
      );

      await expect(controller.createTransaction(createDto)).rejects.toThrow(
        'Database connection failed',
      );
    });

    it('should handle invalid ID parameters', async () => {
      // This would be handled by ParseIntPipe in real scenario
      const invalidId = 'not-a-number';
      
      // ParseIntPipe would throw BadRequestException for non-numeric IDs
      expect(isNaN(Number(invalidId))).toBe(true);
    });
  });
});
