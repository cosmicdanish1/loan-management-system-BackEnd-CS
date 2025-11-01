import { Test, TestingModule } from '@nestjs/testing';
import { CalculationService, EMICalculationResult, CompoundInterestResult, AmortizationSchedule } from './calculation.service';

describe('CalculationService', () => {
  let service: CalculationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CalculationService],
    }).compile();

    service = module.get<CalculationService>(CalculationService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('calculateEMI', () => {
    it('should calculate EMI correctly for standard loan', () => {
      const result = service.calculateEMI(100000, 12, 12); // 1 lakh, 12% annual, 12 months
      
      expect(result.emi).toBeCloseTo(8884.88, 2);
      expect(result.totalAmount).toBeCloseTo(106618.56, 2);
      expect(result.totalInterest).toBeCloseTo(6618.56, 2);
      expect(result.monthlyBreakdown).toHaveLength(12);
      expect(result.monthlyBreakdown[0].principal).toBeGreaterThan(0);
      expect(result.monthlyBreakdown[0].interest).toBeGreaterThan(0);
      expect(result.monthlyBreakdown[11].balance).toBeCloseTo(0, 2);
    });

    it('should handle zero interest rate', () => {
      const result = service.calculateEMI(120000, 0, 12);
      
      expect(result.emi).toBe(10000);
      expect(result.totalAmount).toBe(120000);
      expect(result.totalInterest).toBe(0);
      expect(result.monthlyBreakdown[0].interest).toBe(0);
      expect(result.monthlyBreakdown[0].principal).toBe(10000);
    });

    it('should throw error for invalid parameters', () => {
      expect(() => service.calculateEMI(0, 12, 12)).toThrow('Invalid input parameters for EMI calculation');
      expect(() => service.calculateEMI(100000, -1, 12)).toThrow('Invalid input parameters for EMI calculation');
      expect(() => service.calculateEMI(100000, 12, 0)).toThrow('Invalid input parameters for EMI calculation');
    });

    it('should calculate EMI for long tenure loan', () => {
      const result = service.calculateEMI(500000, 10, 240); // 5 lakh, 10% annual, 20 years
      
      expect(result.emi).toBeCloseTo(4827.02, 2);
      expect(result.totalAmount).toBeCloseTo(1158484.8, 2);
      expect(result.totalInterest).toBeCloseTo(658484.8, 2);
      expect(result.monthlyBreakdown).toHaveLength(240);
    });
  });

  describe('calculateCompoundInterest', () => {
    it('should calculate compound interest correctly', () => {
      const result = service.calculateCompoundInterest(100000, 8, 2); // 1 lakh, 8% annual, 2 years, monthly compounding
      
      expect(result.maturityAmount).toBeCloseTo(117289.42, 2);
      expect(result.interestEarned).toBeCloseTo(17289.42, 2);
      expect(result.effectiveRate).toBeCloseTo(17.2894, 4);
    });

    it('should handle different compounding frequencies', () => {
      const quarterly = service.calculateCompoundInterest(100000, 8, 2, 4);
      const annually = service.calculateCompoundInterest(100000, 8, 2, 1);
      
      expect(quarterly.maturityAmount).toBeCloseTo(117166.40, 2);
      expect(annually.maturityAmount).toBeCloseTo(116640, 2);
      expect(quarterly.maturityAmount).toBeGreaterThan(annually.maturityAmount);
    });

    it('should throw error for invalid parameters', () => {
      expect(() => service.calculateCompoundInterest(0, 8, 2)).toThrow('Invalid input parameters for compound interest calculation');
      expect(() => service.calculateCompoundInterest(100000, -1, 2)).toThrow('Invalid input parameters for compound interest calculation');
      expect(() => service.calculateCompoundInterest(100000, 8, -1)).toThrow('Invalid input parameters for compound interest calculation');
      expect(() => service.calculateCompoundInterest(100000, 8, 2, 0)).toThrow('Invalid input parameters for compound interest calculation');
    });

    it('should handle zero interest rate', () => {
      const result = service.calculateCompoundInterest(100000, 0, 2);
      
      expect(result.maturityAmount).toBe(100000);
      expect(result.interestEarned).toBe(0);
      expect(result.effectiveRate).toBe(0);
    });
  });

  describe('generateAmortizationSchedule', () => {
    it('should generate correct amortization schedule', () => {
      const startDate = new Date('2024-01-01');
      const schedule = service.generateAmortizationSchedule(100000, 12, 12, startDate);
      
      expect(schedule).toHaveLength(12);
      expect(schedule[0].installmentNumber).toBe(1);
      expect(schedule[0].openingBalance).toBe(100000);
      expect(schedule[0].closingBalance).toBeLessThan(100000);
      expect(schedule[11].closingBalance).toBeCloseTo(0, 2);
      
      // Check date progression
      expect(schedule[0].installmentDate.getMonth()).toBe(1); // February (0-indexed)
      expect(schedule[11].installmentDate.getMonth()).toBe(0); // January next year
    });

    it('should maintain balance consistency throughout schedule', () => {
      const schedule = service.generateAmortizationSchedule(50000, 10, 6, new Date());
      
      for (let i = 0; i < schedule.length - 1; i++) {
        expect(schedule[i].closingBalance).toBeCloseTo(schedule[i + 1].openingBalance, 2);
      }
      
      // Total principal should equal original amount
      const totalPrincipal = schedule.reduce((sum, entry) => sum + entry.principalComponent, 0);
      expect(totalPrincipal).toBeCloseTo(50000, 2);
    });
  });

  describe('calculateSimpleInterest', () => {
    it('should calculate simple interest correctly', () => {
      const interest = service.calculateSimpleInterest(100000, 10, 2);
      
      expect(interest).toBe(20000);
    });

    it('should handle fractional values', () => {
      const interest = service.calculateSimpleInterest(75000, 8.5, 1.5);
      
      expect(interest).toBeCloseTo(9562.5, 2);
    });

    it('should throw error for invalid parameters', () => {
      expect(() => service.calculateSimpleInterest(0, 10, 2)).toThrow('Invalid input parameters for simple interest calculation');
      expect(() => service.calculateSimpleInterest(100000, -1, 2)).toThrow('Invalid input parameters for simple interest calculation');
      expect(() => service.calculateSimpleInterest(100000, 10, -1)).toThrow('Invalid input parameters for simple interest calculation');
    });

    it('should handle zero interest rate', () => {
      const interest = service.calculateSimpleInterest(100000, 0, 2);
      
      expect(interest).toBe(0);
    });
  });

  describe('calculatePresentValue', () => {
    it('should calculate present value correctly', () => {
      const pv = service.calculatePresentValue(110000, 10, 1);
      
      expect(pv).toBeCloseTo(100000, 2);
    });

    it('should handle multiple periods', () => {
      const pv = service.calculatePresentValue(121000, 10, 2);
      
      expect(pv).toBeCloseTo(100000, 2);
    });

    it('should throw error for invalid parameters', () => {
      expect(() => service.calculatePresentValue(0, 10, 1)).toThrow('Invalid input parameters for present value calculation');
      expect(() => service.calculatePresentValue(110000, -1, 1)).toThrow('Invalid input parameters for present value calculation');
      expect(() => service.calculatePresentValue(110000, 10, -1)).toThrow('Invalid input parameters for present value calculation');
    });
  });

  describe('calculateFutureValue', () => {
    it('should calculate future value correctly', () => {
      const fv = service.calculateFutureValue(100000, 10, 1);
      
      expect(fv).toBeCloseTo(110000, 2);
    });

    it('should handle multiple periods', () => {
      const fv = service.calculateFutureValue(100000, 10, 2);
      
      expect(fv).toBeCloseTo(121000, 2);
    });

    it('should throw error for invalid parameters', () => {
      expect(() => service.calculateFutureValue(0, 10, 1)).toThrow('Invalid input parameters for future value calculation');
      expect(() => service.calculateFutureValue(100000, -1, 1)).toThrow('Invalid input parameters for future value calculation');
      expect(() => service.calculateFutureValue(100000, 10, -1)).toThrow('Invalid input parameters for future value calculation');
    });

    it('should handle zero interest rate', () => {
      const fv = service.calculateFutureValue(100000, 0, 5);
      
      expect(fv).toBe(100000);
    });
  });

  describe('calculatePenalty', () => {
    it('should calculate penalty correctly', () => {
      const penalty = service.calculatePenalty(100000, 2, 30); // 2% annual penalty, 30 days early
      
      expect(penalty).toBeCloseTo(164.38, 2);
    });

    it('should handle different penalty rates and periods', () => {
      const penalty1 = service.calculatePenalty(50000, 1.5, 60);
      const penalty2 = service.calculatePenalty(50000, 3, 30);
      
      expect(penalty1).toBeCloseTo(123.29, 2);
      expect(penalty2).toBeCloseTo(123.29, 2);
    });

    it('should throw error for invalid parameters', () => {
      expect(() => service.calculatePenalty(0, 2, 30)).toThrow('Invalid input parameters for penalty calculation');
      expect(() => service.calculatePenalty(100000, -1, 30)).toThrow('Invalid input parameters for penalty calculation');
      expect(() => service.calculatePenalty(100000, 2, -1)).toThrow('Invalid input parameters for penalty calculation');
    });

    it('should handle zero penalty rate', () => {
      const penalty = service.calculatePenalty(100000, 0, 30);
      
      expect(penalty).toBe(0);
    });

    it('should handle zero days early', () => {
      const penalty = service.calculatePenalty(100000, 2, 0);
      
      expect(penalty).toBe(0);
    });
  });

  describe('Edge cases and precision', () => {
    it('should handle very small amounts', () => {
      const result = service.calculateEMI(100, 12, 12);
      
      expect(result.emi).toBeGreaterThan(0);
      expect(result.totalAmount).toBeGreaterThan(100);
    });

    it('should handle very large amounts', () => {
      const result = service.calculateEMI(10000000, 15, 360); // 1 crore, 15%, 30 years
      
      expect(result.emi).toBeGreaterThan(0);
      expect(result.totalAmount).toBeGreaterThan(10000000);
    });

    it('should maintain precision in calculations', () => {
      const result = service.calculateEMI(123456.78, 11.25, 84);
      
      // Check that calculations maintain reasonable precision
      expect(result.emi).toBeCloseTo(Math.round(result.emi * 100) / 100, 2);
      expect(result.totalAmount).toBeCloseTo(Math.round(result.totalAmount * 100) / 100, 2);
    });
  });
});
