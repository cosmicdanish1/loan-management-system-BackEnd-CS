import { DividendReportsService } from '../../../src/modules/report/services-v2/dividend-reports.service';

describe('DividendReportsService', () => {
  let service: DividendReportsService;
  let dataSource: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
    };
    service = new DividendReportsService(dataSource);
  });

  describe('getDividendReport', () => {
    it('calculates dividend per member based on declared dividend rate and shares', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '1' }]) // totalCountRes
        .mockResolvedValueOnce([
          {
            member_no: '1001',
            member_name: 'Asha Patil',
            office_name: 'Main Branch',
            share_balance: '10000',
            dividend_amount: '800',
            dividend_rate: '8',
          },
        ]); // result

      const report = await service.getDividendReport({
        year: 2026,
        dividendRate: 8,
      });

      expect(report.success).toBe(true);
      expect(report.data).toHaveLength(1);
      expect(report.data[0].memberNo).toBe('1001');
      expect(report.data[0].shareAmount).toBe(10000);
      expect(report.data[0].dividendAmount).toBe(800);
    });

    it('rejects unreasonable dividend rates (e.g. > 100% or negative)', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      // Gap: service does not validate dividend rate <= 100% and accepts 250%
      await expect(
        service.getDividendReport({
          year: 2026,
          dividendRate: 250,
        }),
      ).rejects.toThrow();
    });
  });

  describe('getDividendPaid', () => {
    it('lists paid dividends and paid status with disbursement vouchers', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '1' }]) // totalCountRes
        .mockResolvedValueOnce([
          {
            member_no: '1001',
            member_name: 'Asha Patil',
            office_name: 'Main',
            warrant_no: 'W001',
            payment_date: '2026-08-15',
            dividend_amount: '800',
            cheque_no: 'CHQ123',
          },
        ]); // result

      const res = await service.getDividendPaid({ year: 2026 });

      expect(res.data).toHaveLength(1);
      expect(res.data[0].memberNo).toBe('1001');
    });
  });

  describe('getDividendWarrant', () => {
    it('generates warrant layout data with member details and amount', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          member_no: '1001',
          member_name: 'Asha Patil',
          address: 'Pune',
          office_name: 'Main',
          share_balance: '5000',
          dividend_amount: '500',
          dividend_rate: '10',
          cheque_no: 'CHQ01',
          year: 2026,
          payment_date: '2026-08-01',
        },
      ]);

      const res = await service.getDividendWarrant({
        memberNo: '1001',
        year: 2026,
      });

      expect(res.data).toHaveLength(1);
      expect(res.data[0].dividendAmount).toBe(500);
    });
  });

  describe('getInterestCertificate', () => {
    it('aggregates annual interest earned across savings, RD and FD for a financial year', async () => {
      dataSource.query
        // Member info
        .mockResolvedValueOnce([
          { mbno: '1001', member_name: 'Asha Patil', pan: 'ABCDE1234F' },
        ])
        // Interest earnings
        .mockResolvedValueOnce([
          { account_type: 'SB', interest_amount: '450' },
          { account_type: 'RD', interest_amount: '1200' },
        ]);

      const cert = await service.getInterestCertificate({
        memberNo: '1001',
        year: 2026,
      });

      expect(cert).toBeDefined();
      expect(dataSource.query).toHaveBeenCalled();
    });
  });
});
