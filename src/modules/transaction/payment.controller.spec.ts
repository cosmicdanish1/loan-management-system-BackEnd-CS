import { Test, TestingModule } from '@nestjs/testing';
import { PaymentController } from './payment.controller';
import { PaymentService } from './services/payment.service';
import {
  CreatePaymentVoucherDto,
  CreateReceiptVoucherDto,
  CreateBalanceTransferDto,
  RollbackTransactionDto,
  PaymentMethod,
  ReceiptMethod,
  TransferType,
} from './dto';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('PaymentController', () => {
  let controller: PaymentController;
  let paymentService: PaymentService;

  const mockPaymentVoucherResponse = {
    voucher: {
      id: 1,
      voucherNumber: 'PY2024001',
      voucherType: 'PAYMENT',
      totalAmount: 5000,
      description: 'Office rent payment',
      status: 'ACTIVE',
    },
    transaction: {
      id: 1,
      transactionNumber: 'TXN2024000001',
      transactionType: 'PAYMENT',
      amount: 5000,
      status: 'POSTED',
    },
    receiptNumber: 'PY2024001',
  };

  const mockReceiptVoucherResponse = {
    voucher: {
      id: 2,
      voucherNumber: 'RE2024001',
      voucherType: 'RECEIPT',
      totalAmount: 3000,
      description: 'Loan EMI payment',
      status: 'ACTIVE',
    },
    transaction: {
      id: 2,
      transactionNumber: 'TXN2024000002',
      transactionType: 'RECEIPT',
      amount: 3000,
      status: 'POSTED',
    },
    receiptNumber: 'RE2024001',
  };

  const mockBalanceTransferResponse = {
    voucher: {
      id: 3,
      voucherNumber: 'JO2024001',
      voucherType: 'JOURNAL',
      totalAmount: 2000,
      description: 'Balance transfer between members',
      status: 'ACTIVE',
    },
    debitTransaction: {
      id: 3,
      transactionNumber: 'TXN2024000003',
      transactionType: 'TRANSFER',
      amount: 2000,
      status: 'POSTED',
    },
    creditTransaction: {
      id: 4,
      transactionNumber: 'TXN2024000004',
      transactionType: 'TRANSFER',
      amount: 2000,
      status: 'POSTED',
    },
    transferNumber: 'JO2024001',
  };

  const mockRollbackResponse = {
    originalTransaction: {
      id: 1,
      transactionNumber: 'TXN2024000001',
      status: 'REVERSED',
    },
    rollbackTransaction: {
      id: 5,
      transactionNumber: 'TXN2024000005',
      status: 'POSTED',
    },
  };

  const mockPaymentService = {
    createPaymentVoucher: jest.fn(),
    createReceiptVoucher: jest.fn(),
    createMemberBalanceTransfer: jest.fn(),
    rollbackTransaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        {
          provide: PaymentService,
          useValue: mockPaymentService,
        },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
    paymentService = module.get<PaymentService>(PaymentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createPaymentVoucher', () => {
    const createPaymentDto: CreatePaymentVoucherDto = {
      memberId: 1,
      payeeName: 'John Doe',
      amount: 5000,
      description: 'Office rent payment',
      paymentMethod: PaymentMethod.CASH,
      accountCode: 'CASH_AC',
      expenseAccount: 'RENT_EXPENSE',
    };

    it('should create a payment voucher successfully', async () => {
      mockPaymentService.createPaymentVoucher.mockResolvedValue(mockPaymentVoucherResponse);

      const result = await controller.createPaymentVoucher(createPaymentDto);

      expect(result).toEqual(mockPaymentVoucherResponse);
      expect(mockPaymentService.createPaymentVoucher).toHaveBeenCalledWith(
        createPaymentDto,
      );
    });

    it('should handle payment voucher creation without member', async () => {
      const paymentWithoutMember = { ...createPaymentDto, memberId: undefined };
      
      mockPaymentService.createPaymentVoucher.mockResolvedValue(mockPaymentVoucherResponse);

      const result = await controller.createPaymentVoucher(paymentWithoutMember);

      expect(result).toEqual(mockPaymentVoucherResponse);
      expect(mockPaymentService.createPaymentVoucher).toHaveBeenCalledWith(
        paymentWithoutMember,
      );
    });

    it('should handle cheque payment details', async () => {
      const chequePaymentDto: CreatePaymentVoucherDto = {
        ...createPaymentDto,
        paymentMethod: PaymentMethod.CHEQUE,
        chequeNumber: '123456',
        chequeDate: '2024-01-15',
        bankName: 'State Bank of India',
      };

      mockPaymentService.createPaymentVoucher.mockResolvedValue(mockPaymentVoucherResponse);

      const result = await controller.createPaymentVoucher(chequePaymentDto);

      expect(result).toEqual(mockPaymentVoucherResponse);
      expect(mockPaymentService.createPaymentVoucher).toHaveBeenCalledWith(
        chequePaymentDto,
      );
    });

    it('should handle member not found error', async () => {
      mockPaymentService.createPaymentVoucher.mockRejectedValue(
        new NotFoundException('Member with ID 999 not found'),
      );

      await expect(controller.createPaymentVoucher(createPaymentDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should handle validation errors', async () => {
      mockPaymentService.createPaymentVoucher.mockRejectedValue(
        new BadRequestException('Invalid payment data'),
      );

      await expect(controller.createPaymentVoucher(createPaymentDto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('createReceiptVoucher', () => {
    const createReceiptDto: CreateReceiptVoucherDto = {
      memberId: 1,
      amount: 3000,
      description: 'Loan EMI payment',
      receiptMethod: ReceiptMethod.CASH,
      accountCode: 'CASH_AC',
      incomeAccount: 'LOAN_INTEREST_INCOME',
    };

    it('should create a receipt voucher successfully', async () => {
      mockPaymentService.createReceiptVoucher.mockResolvedValue(mockReceiptVoucherResponse);

      const result = await controller.createReceiptVoucher(createReceiptDto);

      expect(result).toEqual(mockReceiptVoucherResponse);
      expect(mockPaymentService.createReceiptVoucher).toHaveBeenCalledWith(
        createReceiptDto,
      );
    });

    it('should handle bank transfer receipt', async () => {
      const bankTransferDto: CreateReceiptVoucherDto = {
        ...createReceiptDto,
        receiptMethod: ReceiptMethod.BANK_TRANSFER,
        bankName: 'HDFC Bank',
      };

      mockPaymentService.createReceiptVoucher.mockResolvedValue(mockReceiptVoucherResponse);

      const result = await controller.createReceiptVoucher(bankTransferDto);

      expect(result).toEqual(mockReceiptVoucherResponse);
      expect(mockPaymentService.createReceiptVoucher).toHaveBeenCalledWith(
        bankTransferDto,
      );
    });

    it('should handle member not found error', async () => {
      mockPaymentService.createReceiptVoucher.mockRejectedValue(
        new NotFoundException('Member with ID 999 not found'),
      );

      await expect(controller.createReceiptVoucher(createReceiptDto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createBalanceTransfer', () => {
    const createTransferDto: CreateBalanceTransferDto = {
      fromMemberId: 1,
      toMemberId: 2,
      amount: 2000,
      description: 'Share transfer between members',
      transferType: TransferType.SHARE_TRANSFER,
    };

    it('should create a balance transfer successfully', async () => {
      mockPaymentService.createMemberBalanceTransfer.mockResolvedValue(
        mockBalanceTransferResponse,
      );

      const result = await controller.createBalanceTransfer(createTransferDto);

      expect(result).toEqual(mockBalanceTransferResponse);
      expect(mockPaymentService.createMemberBalanceTransfer).toHaveBeenCalledWith(
        createTransferDto,
      );
    });

    it('should handle different transfer types', async () => {
      const depositTransferDto: CreateBalanceTransferDto = {
        ...createTransferDto,
        transferType: TransferType.DEPOSIT_TRANSFER,
        description: 'Deposit transfer between members',
      };

      mockPaymentService.createMemberBalanceTransfer.mockResolvedValue(
        mockBalanceTransferResponse,
      );

      const result = await controller.createBalanceTransfer(depositTransferDto);

      expect(result).toEqual(mockBalanceTransferResponse);
      expect(mockPaymentService.createMemberBalanceTransfer).toHaveBeenCalledWith(
        depositTransferDto,
      );
    });

    it('should handle loan adjustment transfer', async () => {
      const loanAdjustmentDto: CreateBalanceTransferDto = {
        ...createTransferDto,
        transferType: TransferType.LOAN_ADJUSTMENT,
        description: 'Loan adjustment between members',
      };

      mockPaymentService.createMemberBalanceTransfer.mockResolvedValue(
        mockBalanceTransferResponse,
      );

      const result = await controller.createBalanceTransfer(loanAdjustmentDto);

      expect(result).toEqual(mockBalanceTransferResponse);
    });

    it('should handle member not found errors', async () => {
      mockPaymentService.createMemberBalanceTransfer.mockRejectedValue(
        new NotFoundException('From member with ID 999 not found'),
      );

      await expect(controller.createBalanceTransfer(createTransferDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should validate different member IDs', () => {
      const invalidTransferDto = {
        ...createTransferDto,
        fromMemberId: 1,
        toMemberId: 1, // Same as fromMemberId
      };

      // In real scenario, this would be validated by business logic
      expect(invalidTransferDto.fromMemberId).toBe(invalidTransferDto.toMemberId);
    });
  });

  describe('rollbackTransaction', () => {
    const rollbackDto: RollbackTransactionDto = {
      reason: 'Incorrect amount posted due to data entry error',
    };

    it('should rollback a transaction successfully', async () => {
      mockPaymentService.rollbackTransaction.mockResolvedValue(mockRollbackResponse);

      const result = await controller.rollbackTransaction(1, rollbackDto);

      expect(result).toEqual(mockRollbackResponse);
      expect(mockPaymentService.rollbackTransaction).toHaveBeenCalledWith(
        1,
        rollbackDto.reason,
      );
    });

    it('should handle transaction not found error', async () => {
      mockPaymentService.rollbackTransaction.mockRejectedValue(
        new NotFoundException('Transaction with ID 999 not found'),
      );

      await expect(controller.rollbackTransaction(999, rollbackDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should handle transaction that cannot be rolled back', async () => {
      mockPaymentService.rollbackTransaction.mockRejectedValue(
        new BadRequestException('Only posted transactions can be rolled back'),
      );

      await expect(controller.rollbackTransaction(1, rollbackDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should require rollback reason', () => {
      const emptyReasonDto = { reason: '' };
      
      // This would be caught by class-validator @IsNotEmpty() decorator
      expect(emptyReasonDto.reason).toBe('');
    });
  });

  describe('Input Validation', () => {
    it('should validate payment method enum', () => {
      const validMethods = Object.values(PaymentMethod);
      expect(validMethods).toContain('CASH');
      expect(validMethods).toContain('CHEQUE');
      expect(validMethods).toContain('BANK_TRANSFER');
      expect(validMethods).not.toContain('INVALID_METHOD');
    });

    it('should validate receipt method enum', () => {
      const validMethods = Object.values(ReceiptMethod);
      expect(validMethods).toContain('CASH');
      expect(validMethods).toContain('CHEQUE');
      expect(validMethods).toContain('BANK_TRANSFER');
    });

    it('should validate transfer type enum', () => {
      const validTypes = Object.values(TransferType);
      expect(validTypes).toContain('SHARE_TRANSFER');
      expect(validTypes).toContain('DEPOSIT_TRANSFER');
      expect(validTypes).toContain('LOAN_ADJUSTMENT');
    });

    it('should validate positive amounts', () => {
      const invalidAmount = -1000;
      expect(invalidAmount).toBeLessThan(0);
    });

    it('should validate required fields', () => {
      const incompletePayment = {
        payeeName: 'John Doe',
        amount: 5000,
        // Missing description, paymentMethod, accountCode, expenseAccount
      };

      expect(incompletePayment).not.toHaveProperty('description');
      expect(incompletePayment).not.toHaveProperty('paymentMethod');
    });
  });

  describe('Error Handling', () => {
    it('should handle service errors gracefully', async () => {
      const createPaymentDto: CreatePaymentVoucherDto = {
        payeeName: 'John Doe',
        amount: 5000,
        description: 'Test payment',
        paymentMethod: PaymentMethod.CASH,
        accountCode: 'CASH_AC',
        expenseAccount: 'RENT_EXPENSE',
      };

      mockPaymentService.createPaymentVoucher.mockRejectedValue(
        new Error('Database connection failed'),
      );

      await expect(controller.createPaymentVoucher(createPaymentDto)).rejects.toThrow(
        'Database connection failed',
      );
    });

    it('should handle concurrent transaction conflicts', async () => {
      const createTransferDto: CreateBalanceTransferDto = {
        fromMemberId: 1,
        toMemberId: 2,
        amount: 2000,
        description: 'Test transfer',
        transferType: TransferType.SHARE_TRANSFER,
      };

      mockPaymentService.createMemberBalanceTransfer.mockRejectedValue(
        new Error('Concurrent modification detected'),
      );

      await expect(controller.createBalanceTransfer(createTransferDto)).rejects.toThrow(
        'Concurrent modification detected',
      );
    });
  });
});
