import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DefaulterTrackingService } from './defaulter-tracking.service';
import { LoanAccount } from '../entities/loan-account.entity';

describe('DefaulterTrackingService', () => {
  let service: DefaulterTrackingService;
  let loanRepository: Repository<LoanAccount>;

  const mockLoanRepository = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };

  const mockMember = {
    id: 1,
    memberNumber: 'MEM001',
    firstName: 'John',
    lastName: 'Doe',
    fullName: 'John Doe',
    phoneNumber: '1234567890',
  };

  const mockOverdueLoan: LoanAccount = {
    id: 1,
    accountNumber: 'LN24000001',
    member: mockMember as any,
    memberId: 1,
    principalAmount: 100000,
    interestRate: 12.0,
    outstandingBalance: 80000,
    loanType: 'PERSONAL',
    disbursementDate: new Date('2024-01-01'),
    maturityDate: new Date('2023-12-01'), // Overdue
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
    payments: [
      {
        id: 1,
        paymentDate: new Date('2024-01-15'),
        amount: 10000,
      } as any,
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    get isOverdue() { return true; },
    get remainingBalance() { return Number(this.outstandingBalance); },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DefaulterTrackingService,
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockLoanRepository,
        },
      ],
    }).compile();

    service = module.get<DefaulterTrackingService>(DefaulterTrackingService);
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));

    jest.clearAllMocks();
    mockLoanRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  });

  describe('getDefaulterList', () => {
    it('should return list of defaulters with correct categorization', async () => {
      const overdueLoans = [mockOverdueLoan];
      mockQueryBuilder.getMany.mockResolvedValue(overdueLoans);

      const result = await service.getDefaulterList();

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('loanId', 1);
      expect(result[0]).toHaveProperty('accountNumber', 'LN24000001');
      expect(result[0]).toHaveProperty('memberName', 'John Doe');
      expect(result[0]).toHaveProperty('daysPastDue');
      expect(result[0]).toHaveProperty('defaulterCategory');
      expect(result[0]).toHaveProperty('recommendedAction');
      expect(result[0].daysPastDue).toBeGreaterThan(0);
    });

    it('should categorize defaulters correctly based on days past due', async () => {
      // Create loans with different overdue periods
      const mildOverdue = {
        ...mockOverdueLoan,
        id: 1,
        maturityDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
      };
      const moderateOverdue = {
        ...mockOverdueLoan,
        id: 2,
        maturityDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 45 days ago
      };
      const severeOverdue = {
        ...mockOverdueLoan,
        id: 3,
        maturityDate: new Date(Date.now() - 75 * 24 * 60 * 60 * 1000), // 75 days ago
      };
      const criticalOverdue = {
        ...mockOverdueLoan,
        id: 4,
        maturityDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), // 120 days ago
      };

      mockQueryBuilder.getMany.mockResolvedValue([
        mildOverdue,
        moderateOverdue,
        severeOverdue,
        criticalOverdue,
      ]);

      const result = await service.getDefaulterList();

      expect(result).toHaveLength(4);
      expect(result[0].defaulterCategory).toBe('MILD');
      expect(result[1].defaulterCategory).toBe('MODERATE');
      expect(result[2].defaulterCategory).toBe('SEVERE');
      expect(result[3].defaulterCategory).toBe('CRITICAL');
    });
  });

  describe('getDefaulterSummary', () => {
    it('should return correct summary statistics', async () => {
      const overdueLoans = [
        { ...mockOverdueLoan, id: 1, outstandingBalance: 50000, maturityDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) },
        { ...mockOverdueLoan, id: 2, outstandingBalance: 75000, maturityDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
        { ...mockOverdueLoan, id: 3, outstandingBalance: 100000, maturityDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) },
      ];
      mockQueryBuilder.getMany.mockResolvedValue(overdueLoans);

      const result = await service.getDefaulterSummary();

      expect(result).toHaveProperty('totalDefaulters', 3);
      expect(result).toHaveProperty('totalOutstandingAmount', 225000);
      expect(result).toHaveProperty('categoryBreakdown');
      expect(result).toHaveProperty('amountBreakdown');
      expect(result.categoryBreakdown.mild).toBe(1);
      expect(result.categoryBreakdown.moderate).toBe(1);
      expect(result.categoryBreakdown.critical).toBe(1);
    });
  });

  describe('getDefaultersByCategory', () => {
    it('should return defaulters filtered by category', async () => {
      const overdueLoans = [
        { ...mockOverdueLoan, id: 1, maturityDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) }, // MILD
        { ...mockOverdueLoan, id: 2, maturityDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) }, // MODERATE
        { ...mockOverdueLoan, id: 3, maturityDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) }, // CRITICAL
      ];
      mockQueryBuilder.getMany.mockResolvedValue(overdueLoans);

      const result = await service.getDefaultersByCategory('MODERATE');

      expect(result).toHaveLength(1);
      expect(result[0].defaulterCategory).toBe('MODERATE');
    });
  });

  describe('getDefaultersByDaysRange', () => {
    it('should return defaulters within specified days range', async () => {
      const overdueLoans = [
        { ...mockOverdueLoan, id: 1, maturityDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) }, // 15 days
        { ...mockOverdueLoan, id: 2, maturityDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) }, // 45 days
        { ...mockOverdueLoan, id: 3, maturityDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) }, // 120 days
      ];
      mockQueryBuilder.getMany.mockResolvedValue(overdueLoans);

      const result = await service.getDefaultersByDaysRange(30, 90);

      expect(result).toHaveLength(1);
      expect(result[0].daysPastDue).toBeGreaterThanOrEqual(30);
      expect(result[0].daysPastDue).toBeLessThanOrEqual(90);
    });

    it('should return defaulters with minimum days when no max specified', async () => {
      const overdueLoans = [
        { ...mockOverdueLoan, id: 1, maturityDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) }, // 15 days
        { ...mockOverdueLoan, id: 2, maturityDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) }, // 45 days
        { ...mockOverdueLoan, id: 3, maturityDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) }, // 120 days
      ];
      mockQueryBuilder.getMany.mockResolvedValue(overdueLoans);

      const result = await service.getDefaultersByDaysRange(30);

      expect(result).toHaveLength(2);
      result.forEach(defaulter => {
        expect(defaulter.daysPastDue).toBeGreaterThanOrEqual(30);
      });
    });
  });

  describe('markLoansAsDefaulted', () => {
    it('should mark overdue loans as defaulted', async () => {
      const loansToDefault = [
        { ...mockOverdueLoan, id: 1 },
        { ...mockOverdueLoan, id: 2 },
      ];
      mockQueryBuilder.getMany.mockResolvedValue(loansToDefault);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 2 });

      const result = await service.markLoansAsDefaulted(90);

      expect(result.markedCount).toBe(2);
      expect(result.markedLoans).toHaveLength(2);
      expect(result.markedLoans[0]).toHaveProperty('id', 1);
      expect(result.markedLoans[0]).toHaveProperty('accountNumber', 'LN24000001');
      expect(result.markedLoans[0]).toHaveProperty('memberName', 'John Doe');
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({ status: 'DEFAULTED' });
    });

    it('should use default 90 days when not specified', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 0 });

      const result = await service.markLoansAsDefaulted();

      expect(result.markedCount).toBe(0);
      expect(mockQueryBuilder.update).toHaveBeenCalled();
    });
  });

  describe('generateDefaulterReport', () => {
    it('should generate comprehensive defaulter report', async () => {
      const fromDate = new Date('2024-01-01');
      const toDate = new Date('2024-01-31');
      
      const newDefaulters = [mockOverdueLoan];
      const recoveredLoans = [
        {
          ...mockOverdueLoan,
          id: 2,
          status: 'CLOSED',
          closureDate: new Date('2024-01-15'),
        },
      ];

      mockQueryBuilder.getMany
        .mockResolvedValueOnce(newDefaulters) // New defaulters
        .mockResolvedValueOnce(recoveredLoans) // Recovered loans
        .mockResolvedValueOnce(newDefaulters); // For summary

      const result = await service.generateDefaulterReport(fromDate, toDate);

      expect(result).toHaveProperty('reportPeriod');
      expect(result).toHaveProperty('newDefaulters');
      expect(result).toHaveProperty('recoveredLoans');
      expect(result).toHaveProperty('summary');
      expect(result.reportPeriod.from).toEqual(fromDate);
      expect(result.reportPeriod.to).toEqual(toDate);
      expect(result.newDefaulters).toHaveLength(1);
      expect(result.recoveredLoans).toHaveLength(1);
    });
  });

  describe('getRecoverySuggestions', () => {
    it('should provide recovery suggestions for a loan', async () => {
      mockLoanRepository.findOne.mockResolvedValue(mockOverdueLoan);

      const result = await service.getRecoverySuggestions(1);

      expect(result).toHaveProperty('loanInfo');
      expect(result).toHaveProperty('suggestions');
      expect(result.loanInfo.loanId).toBe(1);
      expect(result.suggestions).toBeInstanceOf(Array);
      expect(result.suggestions.length).toBeGreaterThan(0);
      
      // Check suggestion structure
      const suggestion = result.suggestions[0];
      expect(suggestion).toHaveProperty('action');
      expect(suggestion).toHaveProperty('description');
      expect(suggestion).toHaveProperty('priority');
      expect(suggestion).toHaveProperty('estimatedRecoveryAmount');
    });

    it('should throw error if loan not found', async () => {
      mockLoanRepository.findOne.mockResolvedValue(null);

      await expect(service.getRecoverySuggestions(999)).rejects.toThrow('Loan not found');
    });

    it('should provide different suggestions based on defaulter category', async () => {
      const criticalOverdueLoan = {
        ...mockOverdueLoan,
        maturityDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), // 120 days overdue
      };
      mockLoanRepository.findOne.mockResolvedValue(criticalOverdueLoan);

      const result = await service.getRecoverySuggestions(1);

      // Critical defaulters should have legal action suggestion
      const legalActionSuggestion = result.suggestions.find(s => s.action === 'Legal Action');
      expect(legalActionSuggestion).toBeDefined();
      expect(legalActionSuggestion.priority).toBe('HIGH');
    });
  });

  describe('private helper methods', () => {
    it('should categorize defaulters correctly', async () => {
      // Test through getDefaulterList which uses the private method
      const testLoans = [
        { ...mockOverdueLoan, id: 1, maturityDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) }, // 15 days - MILD
        { ...mockOverdueLoan, id: 2, maturityDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) }, // 45 days - MODERATE
        { ...mockOverdueLoan, id: 3, maturityDate: new Date(Date.now() - 75 * 24 * 60 * 60 * 1000) }, // 75 days - SEVERE
        { ...mockOverdueLoan, id: 4, maturityDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) }, // 120 days - CRITICAL
      ];
      mockQueryBuilder.getMany.mockResolvedValue(testLoans);

      const result = await service.getDefaulterList();

      expect(result[0].defaulterCategory).toBe('MILD');
      expect(result[0].recommendedAction).toBe('Send reminder notice and make phone call');
      
      expect(result[1].defaulterCategory).toBe('MODERATE');
      expect(result[1].recommendedAction).toBe('Send formal notice and schedule meeting');
      
      expect(result[2].defaulterCategory).toBe('SEVERE');
      expect(result[2].recommendedAction).toBe('Issue legal notice and involve guarantor');
      
      expect(result[3].defaulterCategory).toBe('CRITICAL');
      expect(result[3].recommendedAction).toBe('Initiate recovery proceedings and asset seizure');
    });

    it('should calculate days past due correctly', async () => {
      const testDate = new Date();
      const maturityDate = new Date(testDate.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      
      const testLoan = {
        ...mockOverdueLoan,
        maturityDate,
      };
      mockQueryBuilder.getMany.mockResolvedValue([testLoan]);

      const result = await service.getDefaulterList();

      expect(result[0].daysPastDue).toBeCloseTo(30, 0); // Allow for small time differences
    });
  });

  describe('automatedDefaulterTracking', () => {
    it('should run automated tracking without errors', async () => {
      // Mock console methods to avoid output during tests
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      mockQueryBuilder.getMany.mockResolvedValue([mockOverdueLoan]);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 1 });

      // Should not throw any errors
      await expect(service.automatedDefaulterTracking()).resolves.toBeUndefined();

      consoleSpy.mockRestore();
    });

    it('should handle errors gracefully in automated tracking', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      
      // Mock an error in the process
      mockQueryBuilder.getMany.mockRejectedValue(new Error('Database error'));

      // Should not throw, but handle error gracefully
      await expect(service.automatedDefaulterTracking()).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith('Error in automated defaulter tracking:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });
});
