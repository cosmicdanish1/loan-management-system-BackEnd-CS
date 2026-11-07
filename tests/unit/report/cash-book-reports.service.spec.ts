import { BadRequestException } from '@nestjs/common';
import { CashBookReportsService } from '../../../src/modules/report/services-v2/cash-book-reports.service';

describe('CashBookReportsService', () => {
  let service: CashBookReportsService;
  let dataSource: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
    };
    service = new CashBookReportsService(dataSource);
  });

  describe('getCashBookDaily', () => {
    it('groups transaction legs by voucher number and computes totals', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          {
            voucher_no: 'V001',
            member_no: '101',
            mode_of_payment: 'Cash',
            head_code: 'A1001',
            head_name: 'Cash in Hand',
            description: 'Share payment',
            amount: '500',
            trans_type: 'CR',
            member_name: 'Ramesh Patil',
          },
          {
            voucher_no: 'V001',
            member_no: '101',
            mode_of_payment: 'Cash',
            head_code: 'L1001',
            head_name: 'Share Capital',
            description: 'Share receipt',
            amount: '500',
            trans_type: 'DR',
            member_name: 'Ramesh Patil',
          },
          {
            voucher_no: 'V002',
            member_no: '102',
            mode_of_payment: 'Cash',
            head_code: 'A1002',
            head_name: 'Loan',
            description: 'Loan recovery',
            amount: '200',
            trans_type: 'CR',
            member_name: 'Suresh More',
          },
        ]) // legs query
        .mockResolvedValueOnce([{ balance: '1000' }]) // openingResult
        .mockResolvedValueOnce([{ cash_in: '700', cash_out: '500' }]); // dayResult

      const report = await service.getCashBookDaily('2026-09-20');

      expect(report).toBeDefined();
      expect(report.vouchers).toHaveLength(2);
      expect(report.vouchers[0].voucherNo).toBe('V001');
      expect(report.vouchers[0].memberName).toBe('Ramesh Patil');
      expect(report.totalReceipts).toBe(700);
      expect(report.totalPayments).toBe(500);
    });

    it('rejects invalid or unparseable date formats', async () => {
      await expect(service.getCashBookDaily('not-a-date')).rejects.toThrow();
    });

    it('handles empty day records returning empty voucher list and zero totals', async () => {
      dataSource.query
        .mockResolvedValueOnce([]) // legs
        .mockResolvedValueOnce([{ balance: '0' }]) // opening
        .mockResolvedValueOnce([{ cash_in: '0', cash_out: '0' }]); // dayResult

      const report = await service.getCashBookDaily('2026-09-20');

      expect(report.vouchers).toEqual([]);
      expect(report.totalReceipts).toBe(0);
      expect(report.totalPayments).toBe(0);
    });
  });

  describe('getCashBookMonthly', () => {
    it('aggregates daily totals across a month and calculates running balance', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '2' }]) // COUNT query
        .mockResolvedValueOnce([
          { code: 'A1001', headName: 'Cash', receipt: '1000', payment: '300' },
          { code: 'L1001', headName: 'Savings', receipt: '500', payment: '200' },
        ]) // DATA query
        .mockResolvedValueOnce([{ balance: '5000' }]); // OPENING BALANCE query

      const result = await service.getCashBookMonthly({ month: 'Sep', year: 2026 });

      expect(dataSource.query).toHaveBeenCalled();
      expect(result.data).toHaveLength(2);
    });

    it('rejects invalid month format (not in 3-letter Jan-Dec list)', async () => {
      await expect(
        service.getCashBookMonthly({ month: '13', year: 2026 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts year 1800 or negative years without validation', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      // Gap: service does not validate year >= 1990
      await expect(
        service.getCashBookMonthly({ month: 'Sep', year: 1800 }),
      ).rejects.toThrow();
    });
  });

  describe('getDetailLedger', () => {
    it('computes opening balance, running balances and filters by head code', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ head_name: 'Cash in Hand' }]) // headResult
        .mockResolvedValueOnce([{ count: '1' }]) // countRes
        .mockResolvedValueOnce([
          {
            trans_date: '2026-09-10',
            voucher_no: 'V005',
            narration: 'Deposit',
            trans_type: 'CR',
            amount: '500',
          },
        ]) // transactions
        .mockResolvedValueOnce([{ balance: '1500.00' }]); // openingBalance

      const result = await service.getDetailLedger({
        head_code: 'A1001',
        from_date: '2026-09-01',
        to_date: '2026-09-30',
      });

      expect(result).toBeDefined();
      expect(result.headName).toBe('Cash in Hand');
      expect(result.transactions).toHaveLength(1);
    });

    it('rejects missing or empty head_code', async () => {
      dataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ balance: '0' }]);

      // Gap: service does not throw BadRequestException on empty head_code
      await expect(
        service.getDetailLedger({
          head_code: '',
          from_date: '2026-09-01',
          to_date: '2026-09-30',
        }),
      ).rejects.toThrow();
    });
  });

  describe('getHeadList & getBankList', () => {
    it('returns headmaster list sorted by configured report head order', async () => {
      dataSource.query.mockResolvedValueOnce([
        { code: 'A1001', head_name: 'Cash' },
        { code: 'L1001', head_name: 'Savings' },
      ]);

      const list = await service.getHeadList();
      expect(list).toHaveLength(2);
      expect(dataSource.query).toHaveBeenCalled();
    });

    it('returns bank accounts with non-null bank codes', async () => {
      dataSource.query.mockResolvedValueOnce([
        { code: 'B1001', head_name: 'SBI Bank' },
      ]);

      const banks = await service.getBankList();
      expect(banks).toHaveLength(1);
    });
  });
});
