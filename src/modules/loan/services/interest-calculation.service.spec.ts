import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { InterestCalculationService } from './interest-calculation.service';
import { LoanAccount } from '../entities/loan-account.entity';

describe('InterestCalculationService', () => {
  let service: InterestCalculationService;
  let loanRepository: Repository<LoanAccount>;

  const mockLoanRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockQueryBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };

  const mockLoan: LoanAccount = {
    id: 1,
    accountNumber: 'LN24000001',
    member: {
      id: 1,
      memberNumber: 'MEM001',
      firstName: 'John',
      lastName: 'Doe',
      fullName: 'John Doe',
    } as any,
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterestCalculationService,
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockLoanRepository,
        },
      ],
    }).compile();

    service = module.get<InterestCalculationService>(InterestCalculationService);
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));

    jest.clearAllMocks();
    mockLoanRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  });

  describe('calculateLoanInterest', () => {
    it('should calculate interest for a valid loan', async () => {
      const loanWithOldCalculation = {
        ...mockLoan,
        lastInterestCalculationDate: new Date('2024-01-01'),
      };
      mockLoanRepository.findOne.mockResolvedValue(loanWithOldCalculation);
      mockLoanRepository.save.mockResolvedValue(loanWithOldCalculation);

      const result = await service.calculateLoanInterest(1);

      expect(result).toHaveProperty('loanId', 1);
      expect(result).toHaveProperty('interestAmount');
      expect(result).toHaveProperty('daysCalculated');
      expect(result.daysCalculated).toBeGreaterThan(0);
      expect(mockLoanRepository.save).toHaveBeenCalled();
    });

    it('should throw BadRequestException if loan not found', async () => {
      mockLoanRepository.findOne.mockResolvedValue(null);

      await expect(service.calculateLoanInterest(1)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for non-active loan', async () => {
      const inactiveLoan = { ...mockLoan, status: 'CLOSED' };
      mockLoanRepository.findOne.mockResolvedValue(inactiveLoan);

      await expect(service.calculateLoanInterest(1)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if interest already calculated today', async () => {
      const loanWithTodayCalculation = {
        ...mockLoan,
        lastInterestCalculationDate: new Date(),
      };
      mockLoanRepository.findOne.mockResolvedValue(loanWithTodayCalculation);

      await expect(service.calculateLoanInterest(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('calculateAllLoansInterest', () => {
    it('should calculate interest for all active loans', async () => {
      const activeLoans = [
        { ...mockLoan, id: 1, lastInterestCalculationDate: new Date('2024-01-01') },
        { ...mockLoan, id: 2, lastInterestCalculationDate: new Date('2024-01-01') },
      ];
      mockLoanRepository.find.mockResolvedValue(activeLoans);
      mockLoanRepository.save.mockResolvedValue(mockLoan);

      const results = await service.calculateAllLoansInterest();

      expect(results).toHaveLength(2);
      expect(results[0]).toHaveProperty('loanId', 1);
      expect(results[1]).toHaveProperty('loanId', 2);
    });

    it('should handle errors gracefully and continue with other loans', async () => {
      const activeLoans = [
        { ...mockLoan, id: 1, lastInterestCalculationDate: new Date('2024-01-01') },
        { ...mockLoan, id: 2, lastInterestCalculationDate: new Date() }, // Today's date - should error
      ];
      mockLoanRepository.find.mockResolvedValue(activeLoans);
      mockLoanRepository.save.mockResolvedValue(mockLoan);

      const results = await service.calculateAllLoansInterest();

      expect(results).toHaveLength(1); // Only one successful calculation
      expect(results[0]).toHaveProperty('loanId', 1);
    });
  });

  describe('getInterestRateSlabs', () => {
    it('should return predefined interest rate slabs', () => {
      const slabs = service.getInterestRateSlabs();

      expect(slabs).toBeInstanceOf(Array);
      expect(slabs.length).toBeGreaterThan(0);
      expect(slabs[0]).toHaveProperty('loanType');
      expect(slabs[0]).toHaveProperty('interestRate');
      expect(slabs[0]).toHaveProperty('minAmount');
      expect(slabs[0]).toHaveProperty('maxAmount');
    });
  });

  describe('getApplicableInterestRate', () => {
    it('should return correct interest rate for loan type and amount', () => {
      const rate = service.getApplicableInterestRate('PERSONAL', 25000);
      expect(rate).toBe(15.0); // Based on predefined slabs

      const rate2 = service.getApplicableInterestRate('PERSONAL', 100000);
      expect(rate2).toBe(13.5);
    });

    it('should return default rate if no slab matches', () => {
      const rate = service.getApplicableInterestRate('UNKNOWN_TYPE', 50000);
      expect(rate).toBe(12.0); // Default rate
    });
  });

  describe('calculateCompoundInterest', () => {
    it('should calculate compound interest correctly', () => {
      const interest = service.calculateCompoundInterest(100000, 12, 1); // 1 year
      expect(interest).toBeCloseTo(12682.50, 1); // Approximately 12.68% for monthly compounding
    });

    it('should handle zero rate', () => {
      const interest = service.calculateCompoundInterest(100000, 0, 1);
      expect(interest).toBe(0);
    });
  });

  describe('calculateSimpleInterest', () => {
    it('should calculate simple interest correctly', () => {
      const interest = service.calculateSimpleInterest(100000, 12, 1);
      expect(interest).toBe(12000); // 12% of 100000 for 1 year
    });

    it('should handle fractional time periods', () => {
      const interest = service.calculateSimpleInterest(100000, 12, 0.5);
      expect(interest).toBe(6000); // 6 months
    });
  });

  describe('calculateEMI', () => {
    it('should calculate EMI correctly', () => {
      const emi = service.calculateEMI(100000, 12, 12);
      expect(emi).toBeCloseTo(8884.88, 2);
    });

    it('should handle zero interest rate', () => {
      const emi = service.calculateEMI(100000, 0, 12);
      expect(emi).toBeCloseTo(8333.33, 2); // Principal / tenure
    });

    it('should handle single month tenure', () => {
      const emi = service.calculateEMI(100000, 12, 1);
      expect(emi).toBeCloseTo(101000, 2); // Principal + 1 month interest
    });
  });

  describe('generateAmortizationSchedule', () => {
    it('should generate correct amortization schedule', () => {
      const schedule = service.generateAmortizationSchedule(100000, 12, 12);

      expect(schedule).toHaveLength(12);
      expect(schedule[0]).toHaveProperty('month', 1);
      expect(schedule[0]).toHaveProperty('emiAmount');
      expect(schedule[0]).toHaveProperty('principalAmount');
      expect(schedule[0]).toHaveProperty('interestAmount');
      expect(schedule[0]).toHaveProperty('balance');

      // First month should have higher interest, lower principal
      expect(schedule[0].interestAmount).toBeGreaterThan(schedule[11].interestAmount);
      expect(schedule[0].principalAmount).toBeLessThan(schedule[11].principalAmount);

      // Last month balance should be zero or very close to zero
      expect(schedule[11].balance).toBeLessThanOrEqual(1);
    });

    it('should maintain consistent EMI amount throughout schedule', () => {
      const schedule = service.generateAmortizationSchedule(100000, 12, 12);
      const firstEmi = schedule[0].emiAmount;

      schedule.forEach(month => {
        expect(month.emiAmount).toBeCloseTo(firstEmi, 2);
      });
    });
  });

  describe('markDefaultedLoans', () => {
    it('should mark overdue loans as defaulted', async () => {
      mockQueryBuilder.execute.mockResolvedValue({ affected: 3 });

      const result = await service.markDefaultedLoans(90);

      expect(result).toBe(3);
      expect(mockQueryBuilder.update).toHaveBeenCalled();
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({ status: 'DEFAULTED' });
    });

    it('should use default 90 days if not specified', async () => {
      mockQueryBuilder.execute.mockResolvedValue({ affected: 2 });

      const result = await service.markDefaultedLoans();

      expect(result).toBe(2);
    });
  });

  describe('interest calculation accuracy', () => {
    it('should calculate daily interest accurately', async () => {
      const testLoan = {
        ...mockLoan,
        outstandingBalance: 100000,
        interestRate: 12.0,
        lastInterestCalculationDate: new Date('2024-01-01'),
      };

      // Mock current date to be 31 days later
      const originalDate = Date;
      const mockDate = new Date('2024-02-01');
      global.Date = jest.fn(() => mockDate) as any;
      global.Date.now = originalDate.now;

      mockLoanRepository.findOne.mockResolvedValue(testLoan);
      mockLoanRepository.save.mockResolvedValue(testLoan);

      const result = await service.calculateLoanInterest(1);

      // Expected: 100000 * (12/100) * (31/365) = 1019.18
      expect(result.interestAmount).toBeCloseTo(1019.18, 2);
      expect(result.daysCalculated).toBe(31);

      // Restore original Date
      global.Date = originalDate;
    });
  });
});
