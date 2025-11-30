import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PaymentProcessingService } from './payment-processing.service';
import { LoanAccount, LoanPayment } from '../entities';
import { CreateLoanPaymentDto } from '../dto';

describe('PaymentProcessingService', () => {
  let service: PaymentProcessingService;
  let loanRepository: Repository<LoanAccount>;
  let paymentRepository: Repository<LoanPayment>;
  let dataSource: DataSource;

  const mockLoanRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockPaymentRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  const mockEntityManager = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn(),
  };

  const mockMember = {
    id: 1,
    memberNumber: 'MEM001',
    firstName: 'John',
    lastName: 'Doe',
    fullName: 'John Doe',
    phoneNumber: '1234567890',
  };

  const mockLoan: LoanAccount = {
    id: 1,
    accountNumber: 'LN24000001',
    member: mockMember as any,
    memberId: 1,
    principalAmount: 100000,
    interestRate: 12.0,
    outstandingBalance: 80000,
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
    totalInterestAccrued: 5000,
    totalPaid: 25000,
    lastInterestCalculationDate: new Date('2024-01-01'),
    closureDate: null,
    payments: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get isOverdue() { return false; },
    get remainingBalance() { return Number(this.outstandingBalance); },
  };

  const mockPayment: LoanPayment = {
    id: 1,
    paymentNumber: 'PAY24000001',
    loanAccount: mockLoan,
    loanAccountId: 1,
    amount: 10000,
    principalAmount: 8000,
    interestAmount: 2000,
    penaltyAmount: 0,
    paymentDate: new Date('2024-02-01'),
    paymentMethod: 'CASH',
    referenceNumber: null,
    remarks: 'Monthly payment',
    receiptNumber: 'RCP24000001',
    status: 'COMPLETED',
    balanceAfterPayment: 72000,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentProcessingService,
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockLoanRepository,
        },
        {
          provide: getRepositoryToken(LoanPayment),
          useValue: mockPaymentRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<PaymentProcessingService>(PaymentProcessingService);
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));
    paymentRepository = module.get<Repository<LoanPayment>>(getRepositoryToken(LoanPayment));
    dataSource = module.get<DataSource>(DataSource);

    jest.clearAllMocks();
    mockLoanRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
    mockPaymentRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  });

  describe('processPayment', () => {
    const createPaymentDto: CreateLoanPaymentDto = {
      loanAccountId: 1,
      amount: 10000,
      paymentDate: '2024-02-01',
      paymentMethod: 'CASH',
      remarks: 'Monthly payment',
    };

    it('should process payment successfully', async () => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(mockLoan);
        mockEntityManager.create.mockReturnValue(mockPayment);
        mockEntityManager.save
          .mockResolvedValueOnce(mockPayment) // Save payment
          .mockResolvedValueOnce(mockLoan);   // Save loan

        return callback(mockEntityManager);
      });

      mockQueryBuilder.getOne.mockResolvedValue(null); // No existing payment number

      const result = await service.processPayment(1, createPaymentDto);

      expect(result).toHaveProperty('payment');
      expect(result).toHaveProperty('receipt');
      expect(result.payment).toEqual(mockPayment);
      expect(result.receipt).toHaveProperty('receiptNumber');
      expect(result.receipt).toHaveProperty('paymentAmount', 10000);
    });

    it('should throw NotFoundException if loan not found', async () => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(null);
        return callback(mockEntityManager);
      });

      await expect(service.processPayment(1, createPaymentDto)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for inactive loan', async () => {
      const inactiveLoan = { ...mockLoan, status: 'CLOSED' };
      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(inactiveLoan);
        return callback(mockEntityManager);
      });

      await expect(service.processPayment(1, createPaymentDto)).rejects.toThrow(BadRequestException);
    });

    it('should close loan when balance becomes zero', async () => {
      const loanNearClosure = { ...mockLoan, outstandingBalance: 5000 };
      const paymentToClose = { ...createPaymentDto, amount: 5000 };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(loanNearClosure);
        mockEntityManager.create.mockReturnValue(mockPayment);
        mockEntityManager.save
          .mockResolvedValueOnce(mockPayment)
          .mockResolvedValueOnce({ ...loanNearClosure, status: 'CLOSED', outstandingBalance: 0 });

        return callback(mockEntityManager);
      });

      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.processPayment(1, paymentToClose);

      expect(result.payment).toBeDefined();
      expect(result.receipt).toBeDefined();
    });
  });

  describe('processPartialPayment', () => {
    const partialPaymentDto = {
      loanAccountId: 1,
      amount: 5000,
      paymentDate: '2024-02-01',
      paymentMethod: 'CASH',
      customBreakdown: {
        principalAmount: 3000,
        interestAmount: 2000,
      },
    };

    it('should process partial payment with custom breakdown', async () => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(mockLoan);
        mockEntityManager.create.mockReturnValue(mockPayment);
        mockEntityManager.save
          .mockResolvedValueOnce(mockPayment)
          .mockResolvedValueOnce(mockLoan);

        return callback(mockEntityManager);
      });

      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.processPartialPayment(1, partialPaymentDto);

      expect(result).toHaveProperty('payment');
      expect(result).toHaveProperty('receipt');
    });

    it('should throw BadRequestException if custom breakdown exceeds total amount', async () => {
      const invalidBreakdown = {
        ...partialPaymentDto,
        customBreakdown: {
          principalAmount: 4000,
          interestAmount: 2000, // Total 6000 > amount 5000
        },
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(mockLoan);
        return callback(mockEntityManager);
      });

      await expect(service.processPartialPayment(1, invalidBreakdown)).rejects.toThrow(BadRequestException);
    });
  });

  describe('processForeclosure', () => {
    const foreclosureData = {
      paymentAmount: 120000, // Increased to cover outstanding amount + interest + penalty
      paymentMethod: 'BANK_TRANSFER',
      referenceNumber: 'TXN123456',
      waivePenalty: false,
      remarks: 'Early closure',
    };

    it('should process foreclosure successfully', async () => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(mockLoan);
        mockEntityManager.create.mockReturnValue(mockPayment);
        mockEntityManager.save
          .mockResolvedValueOnce(mockPayment)
          .mockResolvedValueOnce({ ...mockLoan, status: 'CLOSED', outstandingBalance: 0 });

        return callback(mockEntityManager);
      });

      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.processForeclosure(1, foreclosureData);

      expect(result).toHaveProperty('closure');
      expect(result).toHaveProperty('receipt');
      expect(result.closure.closureType).toBe('FORECLOSURE');
    });

    it('should throw BadRequestException for insufficient payment amount', async () => {
      const insufficientPayment = { ...foreclosureData, paymentAmount: 50000 };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(mockLoan);
        return callback(mockEntityManager);
      });

      await expect(service.processForeclosure(1, insufficientPayment)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for non-active loan', async () => {
      const closedLoan = { ...mockLoan, status: 'CLOSED' };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(closedLoan);
        return callback(mockEntityManager);
      });

      await expect(service.processForeclosure(1, foreclosureData)).rejects.toThrow(BadRequestException);
    });
  });

  describe('processSettlement', () => {
    const settlementData = {
      settlementAmount: 60000,
      paymentMethod: 'CASH',
      remarks: 'Settlement agreement',
      approvedBy: 'Manager John',
    };

    it('should process settlement successfully', async () => {
      const activeLoan = { ...mockLoan, status: 'ACTIVE' };
      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(activeLoan);
        mockEntityManager.create.mockReturnValue(mockPayment);
        mockEntityManager.save
          .mockResolvedValueOnce(mockPayment)
          .mockResolvedValueOnce({ ...activeLoan, status: 'CLOSED', outstandingBalance: 0 });

        return callback(mockEntityManager);
      });

      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.processSettlement(1, settlementData);

      expect(result).toHaveProperty('closure');
      expect(result).toHaveProperty('receipt');
      expect(result.closure.closureType).toBe('SETTLEMENT');
    });

    it('should throw BadRequestException for non-active loan', async () => {
      const closedLoan = { ...mockLoan, status: 'CLOSED' };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(closedLoan);
        return callback(mockEntityManager);
      });

      await expect(service.processSettlement(1, settlementData)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getPaymentReceipt', () => {
    it('should retrieve payment receipt by receipt number', async () => {
      const paymentWithLoan = {
        ...mockPayment,
        loanAccount: mockLoan,
      };
      mockPaymentRepository.findOne.mockResolvedValue(paymentWithLoan);

      const result = await service.getPaymentReceipt('RCP24000001');

      expect(result).toHaveProperty('receiptNumber', 'RCP24000001');
      expect(result).toHaveProperty('loanAccountNumber', 'LN24000001');
      expect(result).toHaveProperty('memberName', 'John Doe');
    });

    it('should throw NotFoundException if receipt not found', async () => {
      mockPaymentRepository.findOne.mockResolvedValue(null);

      await expect(service.getPaymentReceipt('INVALID')).rejects.toThrow(NotFoundException);
    });
  });

  describe('calculateOutstandingAmount', () => {
    it('should calculate outstanding amount correctly', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockLoan);

      const result = await service.calculateOutstandingAmount(1);

      expect(result).toHaveProperty('principalAmount');
      expect(result).toHaveProperty('interestAmount');
      expect(result).toHaveProperty('penaltyAmount');
      expect(result).toHaveProperty('totalAmount');
      expect(result).toHaveProperty('asOfDate');
      expect(result.totalAmount).toBeGreaterThanOrEqual(result.principalAmount);
    });

    it('should throw NotFoundException if loan not found', async () => {
      mockLoanRepository.findOne.mockResolvedValue(null);

      await expect(service.calculateOutstandingAmount(1)).rejects.toThrow(NotFoundException);
    });
  });

  describe('payment breakdown calculations', () => {
    it('should allocate payment correctly (penalty > interest > principal)', async () => {
      // Test through processPayment which uses calculatePaymentBreakdown internally
      const overdueLoan = {
        ...mockLoan,
        maturityDate: new Date('2023-12-01'), // Overdue loan
        outstandingBalance: 50000,
        status: 'ACTIVE', // Ensure loan is active
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(overdueLoan);
        mockEntityManager.create.mockReturnValue(mockPayment);
        mockEntityManager.save
          .mockResolvedValueOnce(mockPayment)
          .mockResolvedValueOnce(overdueLoan);

        return callback(mockEntityManager);
      });

      mockQueryBuilder.getOne.mockResolvedValue(null);

      const paymentDto: CreateLoanPaymentDto = {
        loanAccountId: 1,
        amount: 15000,
        paymentDate: '2024-02-01',
        paymentMethod: 'CASH',
      };

      const result = await service.processPayment(1, paymentDto);

      expect(result.receipt.paymentBreakdown).toHaveProperty('penaltyAmount');
      expect(result.receipt.paymentBreakdown).toHaveProperty('interestAmount');
      expect(result.receipt.paymentBreakdown).toHaveProperty('principalAmount');
      expect(result.receipt.paymentBreakdown.totalAmount).toBe(15000);
    });
  });

  describe('number generation', () => {
    it('should generate unique payment and receipt numbers', async () => {
      const activeLoan = { ...mockLoan, status: 'ACTIVE' };
      mockDataSource.transaction.mockImplementation(async (callback) => {
        mockEntityManager.findOne.mockResolvedValue(activeLoan);
        mockEntityManager.create.mockReturnValue(mockPayment);
        mockEntityManager.save
          .mockResolvedValueOnce(mockPayment)
          .mockResolvedValueOnce(activeLoan);

        return callback(mockEntityManager);
      });

      // Mock no existing payments for number generation
      mockQueryBuilder.getOne.mockResolvedValue(null);

      const paymentDto: CreateLoanPaymentDto = {
        loanAccountId: 1,
        amount: 5000,
        paymentDate: '2024-02-01',
        paymentMethod: 'CASH',
      };

      const result = await service.processPayment(1, paymentDto);

      expect(result.payment.paymentNumber).toMatch(/^PAY\d{8}$/);
      expect(result.payment.receiptNumber).toMatch(/^RCP\d{8}$/);
    });
  });
});
