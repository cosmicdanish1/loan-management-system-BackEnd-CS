import { Test, TestingModule } from '@nestjs/testing';
import { LoanController } from './loan.controller';
import { LoanService } from './loan.service';
import { InterestCalculationService, DefaulterTrackingService, PaymentProcessingService } from './services';
import { CreateLoanDto, CreateLoanPaymentDto } from './dto';

describe('LoanController', () => {
  let controller: LoanController;
  let loanService: LoanService;
  let interestCalculationService: InterestCalculationService;
  let defaulterTrackingService: DefaulterTrackingService;
  let paymentProcessingService: PaymentProcessingService;

  const mockLoanService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByAccountNumber: jest.fn(),
    findByMember: jest.fn(),
    update: jest.fn(),
    disburse: jest.fn(),
    close: jest.fn(),
    getPaymentHistory: jest.fn(),
    getEmiSchedule: jest.fn(),
    calculateInterest: jest.fn(),
    updateSurety: jest.fn(),
    remove: jest.fn(),
    getStatistics: jest.fn(),
    getDefaulters: jest.fn(),
  };

  const mockInterestCalculationService = {
    calculateAllLoansInterest: jest.fn(),
    getInterestRateSlabs: jest.fn(),
    getApplicableInterestRate: jest.fn(),
    calculateEMI: jest.fn(),
    generateAmortizationSchedule: jest.fn(),
  };

  const mockDefaulterTrackingService = {
    getDefaulterList: jest.fn(),
    getDefaulterSummary: jest.fn(),
    getDefaultersByCategory: jest.fn(),
    getDefaultersByDaysRange: jest.fn(),
    markLoansAsDefaulted: jest.fn(),
    generateDefaulterReport: jest.fn(),
    getRecoverySuggestions: jest.fn(),
  };

  const mockPaymentProcessingService = {
    processPayment: jest.fn(),
    processPartialPayment: jest.fn(),
    processForeclosure: jest.fn(),
    processSettlement: jest.fn(),
    calculateOutstandingAmount: jest.fn(),
    getPaymentReceipt: jest.fn(),
  };

  const mockLoanResponse = {
    id: 1,
    accountNumber: 'LN24000001',
    member: {
      id: 1,
      memberNumber: 'MEM001',
      firstName: 'John',
      lastName: 'Doe',
      fullName: 'John Doe',
    },
    principalAmount: 100000,
    interestRate: 12.5,
    outstandingBalance: 80000,
    loanType: 'PERSONAL',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LoanController],
      providers: [
        {
          provide: LoanService,
          useValue: mockLoanService,
        },
        {
          provide: InterestCalculationService,
          useValue: mockInterestCalculationService,
        },
        {
          provide: DefaulterTrackingService,
          useValue: mockDefaulterTrackingService,
        },
        {
          provide: PaymentProcessingService,
          useValue: mockPaymentProcessingService,
        },
      ],
    }).compile();

    controller = module.get<LoanController>(LoanController);
    loanService = module.get<LoanService>(LoanService);
    interestCalculationService = module.get<InterestCalculationService>(InterestCalculationService);
    defaulterTrackingService = module.get<DefaulterTrackingService>(DefaulterTrackingService);
    paymentProcessingService = module.get<PaymentProcessingService>(PaymentProcessingService);

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a loan', async () => {
      const createLoanDto: CreateLoanDto = {
        memberId: 1,
        principalAmount: 100000,
        interestRate: 12.5,
        loanType: 'PERSONAL',
        disbursementDate: '2024-01-01',
        maturityDate: '2025-01-01',
        tenureMonths: 12,
      };

      mockLoanService.create.mockResolvedValue(mockLoanResponse);

      const result = await controller.create(createLoanDto);

      expect(mockLoanService.create).toHaveBeenCalledWith(createLoanDto);
      expect(result).toEqual(mockLoanResponse);
    });
  });

  describe('findAll', () => {
    it('should return paginated loans', async () => {
      const mockResponse = {
        data: [mockLoanResponse],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      };

      mockLoanService.findAll.mockResolvedValue(mockResponse);

      const result = await controller.findAll({ page: 1, limit: 10 });

      expect(mockLoanService.findAll).toHaveBeenCalledWith({ page: 1, limit: 10 });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('findOne', () => {
    it('should return a loan by ID', async () => {
      mockLoanService.findOne.mockResolvedValue(mockLoanResponse);

      const result = await controller.findOne(1);

      expect(mockLoanService.findOne).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockLoanResponse);
    });
  });

  describe('recordPayment', () => {
    it('should record a loan payment', async () => {
      const createPaymentDto: CreateLoanPaymentDto = {
        loanAccountId: 1,
        amount: 10000,
        paymentDate: '2024-02-01',
        paymentMethod: 'CASH',
      };

      const mockPaymentResponse = {
        payment: { id: 1, amount: 10000 },
        receipt: { receiptNumber: 'RCP24000001' },
      };

      mockPaymentProcessingService.processPayment.mockResolvedValue(mockPaymentResponse);

      const result = await controller.recordPayment(1, createPaymentDto);

      expect(mockPaymentProcessingService.processPayment).toHaveBeenCalledWith(1, createPaymentDto);
      expect(result).toEqual(mockPaymentResponse);
    });
  });

  describe('getStatistics', () => {
    it('should return loan statistics', async () => {
      const mockStats = {
        totalLoans: 10,
        activeLoans: 7,
        closedLoans: 2,
        defaultedLoans: 1,
        totalDisbursed: 1000000,
        totalOutstanding: 500000,
      };

      mockLoanService.getStatistics.mockResolvedValue(mockStats);

      const result = await controller.getStatistics();

      expect(mockLoanService.getStatistics).toHaveBeenCalled();
      expect(result).toEqual(mockStats);
    });
  });

  describe('calculateAllInterest', () => {
    it('should calculate interest for all loans', async () => {
      const mockResults = [
        { loanId: 1, interestAmount: 1000 },
        { loanId: 2, interestAmount: 1500 },
      ];

      mockInterestCalculationService.calculateAllLoansInterest.mockResolvedValue(mockResults);

      const result = await controller.calculateAllInterest();

      expect(mockInterestCalculationService.calculateAllLoansInterest).toHaveBeenCalled();
      expect(result).toEqual(mockResults);
    });
  });

  describe('getInterestRates', () => {
    it('should return interest rate slabs', async () => {
      const mockRates = [
        { loanType: 'PERSONAL', minAmount: 0, maxAmount: 50000, interestRate: 15.0 },
        { loanType: 'BUSINESS', minAmount: 0, maxAmount: 100000, interestRate: 14.0 },
      ];

      mockInterestCalculationService.getInterestRateSlabs.mockReturnValue(mockRates);

      const result = await controller.getInterestRates();

      expect(mockInterestCalculationService.getInterestRateSlabs).toHaveBeenCalled();
      expect(result).toEqual(mockRates);
    });
  });

  describe('calculateEMI', () => {
    it('should calculate EMI for given parameters', async () => {
      const emiParams = { principal: 100000, annualRate: 12, tenureMonths: 12 };
      const expectedEmi = 8884.88;

      mockInterestCalculationService.calculateEMI.mockReturnValue(expectedEmi);

      const result = await controller.calculateEMI(emiParams);

      expect(mockInterestCalculationService.calculateEMI).toHaveBeenCalledWith(
        emiParams.principal,
        emiParams.annualRate,
        emiParams.tenureMonths,
      );
      expect(result).toEqual({ ...emiParams, emi: expectedEmi });
    });
  });

  describe('getDefaulterList', () => {
    it('should return defaulter list', async () => {
      const mockDefaulters = [
        { loanId: 1, memberName: 'John Doe', daysPastDue: 45 },
        { loanId: 2, memberName: 'Jane Smith', daysPastDue: 120 },
      ];

      mockDefaulterTrackingService.getDefaulterList.mockResolvedValue(mockDefaulters);

      const result = await controller.getDefaulterList();

      expect(mockDefaulterTrackingService.getDefaulterList).toHaveBeenCalled();
      expect(result).toEqual(mockDefaulters);
    });
  });

  describe('getDefaulterSummary', () => {
    it('should return defaulter summary', async () => {
      const mockSummary = {
        totalDefaulters: 5,
        totalOutstandingAmount: 250000,
        categoryBreakdown: { mild: 2, moderate: 1, severe: 1, critical: 1 },
      };

      mockDefaulterTrackingService.getDefaulterSummary.mockResolvedValue(mockSummary);

      const result = await controller.getDefaulterSummary();

      expect(mockDefaulterTrackingService.getDefaulterSummary).toHaveBeenCalled();
      expect(result).toEqual(mockSummary);
    });
  });

  describe('foreclose', () => {
    it('should process loan foreclosure', async () => {
      const foreclosureData = {
        paymentAmount: 85000,
        paymentMethod: 'BANK_TRANSFER',
        waivePenalty: false,
      };

      const mockForeclosureResult = {
        closure: { loanId: 1, closureType: 'FORECLOSURE' },
        receipt: { receiptNumber: 'RCP24000001' },
      };

      mockPaymentProcessingService.processForeclosure.mockResolvedValue(mockForeclosureResult);

      const result = await controller.foreclose(1, foreclosureData);

      expect(mockPaymentProcessingService.processForeclosure).toHaveBeenCalledWith(1, foreclosureData);
      expect(result).toEqual(mockForeclosureResult);
    });
  });

  describe('getOutstandingAmount', () => {
    it('should calculate outstanding amount', async () => {
      const mockOutstanding = {
        principalAmount: 80000,
        interestAmount: 5000,
        penaltyAmount: 1000,
        totalAmount: 86000,
        asOfDate: new Date(),
      };

      mockPaymentProcessingService.calculateOutstandingAmount.mockResolvedValue(mockOutstanding);

      const result = await controller.getOutstandingAmount(1);

      expect(mockPaymentProcessingService.calculateOutstandingAmount).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockOutstanding);
    });
  });

  describe('getPaymentReceipt', () => {
    it('should retrieve payment receipt', async () => {
      const mockReceipt = {
        receiptNumber: 'RCP24000001',
        loanAccountNumber: 'LN24000001',
        memberName: 'John Doe',
        paymentAmount: 10000,
      };

      mockPaymentProcessingService.getPaymentReceipt.mockResolvedValue(mockReceipt);

      const result = await controller.getPaymentReceipt('RCP24000001');

      expect(mockPaymentProcessingService.getPaymentReceipt).toHaveBeenCalledWith('RCP24000001');
      expect(result).toEqual(mockReceipt);
    });
  });

  describe('error handling', () => {
    it('should handle service errors properly', async () => {
      mockLoanService.findOne.mockRejectedValue(new Error('Database error'));

      await expect(controller.findOne(999)).rejects.toThrow('Database error');
    });
  });
});
