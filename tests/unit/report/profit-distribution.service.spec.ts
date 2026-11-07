import { ProfitDistributionService } from '../../../src/modules/report/services-v2/profit-distribution.service';

describe('ProfitDistributionService', () => {
  let service: ProfitDistributionService;
  let dataSource: any;
  let systemConfigService: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
    };
    systemConfigService = {
      getConfigValue: jest.fn(),
    };
    service = new ProfitDistributionService(dataSource, systemConfigService);
  });

  describe('calculateProjectedProfit', () => {
    it('computes fixed interest on fund, dividend on shares and applies CD chart & insurance deduction', async () => {
      systemConfigService.getConfigValue.mockImplementation(async (key: string) => {
        if (key === 'RULE_FUND_INT_RATE') return 7.0;
        if (key === 'RULE_DIVIDEND_PCT') return 5.0;
        if (key === 'RULE_GRP_INSURANCE_AMT') return 500;
        if (key === 'RULE_CD_INTEREST_CHART') return [{ amount: 200, interest: 91.2 }];
        return null;
      });

      dataSource.query
        // 1. Share balance query (A1002)
        .mockResolvedValueOnce([{ total_credit: '10000', total_debit: '0' }])
        // 2. Thrift balance query (A1002)
        .mockResolvedValueOnce([{ total_credit: '20000', total_debit: '0' }])
        // 3. Monthly contribution from ro_national / ro_united
        .mockResolvedValueOnce([{ rd: 200 }]);

      const result = await service.calculateProjectedProfit('1001');

      expect(result).toBeDefined();
      expect(result.memberId).toBe('1001');
      expect(result.currentBalance.shares).toBe(10000);
      expect(result.currentBalance.thrift).toBe(20000);
      expect(result.monthlyContribution).toBe(200);

      // Calculations:
      // fixedInterest = (20000 * 7.0) / 100 = 1400
      // dividend = (10000 * 5.0) / 100 = 500
      // cdInterest = 91.20
      // insurance = 500
      // totalBenefit = 1400 + 91.2 + 500 - 500 = 1491.2
      expect(result.breakdown.fixedInterestOnBalance).toBe(1400);
      expect(result.breakdown.dividend).toBe(500);
      expect(result.breakdown.monthlyFdInterest).toBe(91.2);
      expect(result.breakdown.groupInsurance).toBe(500);
      expect(result.totalProjectedCredit).toBeCloseTo(1491.2, 2);
    });

    it('defaults monthly contribution to 0 when RO data is missing', async () => {
      systemConfigService.getConfigValue.mockImplementation(async (key: string) => {
        if (key === 'RULE_FUND_INT_RATE') return 6.0;
        if (key === 'RULE_DIVIDEND_PCT') return 4.0;
        if (key === 'RULE_GRP_INSURANCE_AMT') return 300;
        if (key === 'RULE_CD_INTEREST_CHART') return [];
        return null;
      });

      dataSource.query
        .mockResolvedValueOnce([{ total_credit: '5000', total_debit: '0' }])
        .mockResolvedValueOnce([{ total_credit: '5000', total_debit: '0' }])
        .mockResolvedValueOnce([]); // No RO data

      const result = await service.calculateProjectedProfit('1002');

      expect(result.monthlyContribution).toBe(0);
      expect(result.breakdown.monthlyFdInterest).toBe(0);
    });
  });
});
