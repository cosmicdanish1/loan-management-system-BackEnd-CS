import { FinancialStatementsService } from '../../../src/modules/report/services-v2/financial-statements.service';

describe('FinancialStatementsService', () => {
  let service: FinancialStatementsService;
  let dataSource: any;
  let queryRunner: any;

  beforeEach(() => {
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    };

    dataSource = {
      query: jest.fn(),
      createQueryRunner: jest.fn(() => queryRunner),
    };

    service = new FinancialStatementsService(dataSource);
  });

  describe('getAllReportSchedules', () => {
    it('queries report schedules filtered by report type', async () => {
      dataSource.query.mockResolvedValueOnce([
        { id: 1, schedule_name: 'Trial Balance Schedule', report_type: 'TB' },
      ]);

      const res = await service.getAllReportSchedules('TB');

      expect(res.success).toBe(true);
      expect(res.data).toHaveLength(1);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('report_schedule_header'),
        ['TB'],
      );
    });
  });

  describe('getReportScheduleDetails', () => {
    it('returns schedule header and ordered details', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          { id: 1, schedule_name: 'BS Schedule', report_type: 'BS' },
        ])
        .mockResolvedValueOnce([
          { id: 10, particulars: 'Cash and Bank', code_from: 'A1001', code_to: 'A1010' },
        ]);

      const res = await service.getReportScheduleDetails(1);

      expect(res.success).toBe(true);
      expect(res.data.schedule_name).toBe('BS Schedule');
      expect(res.data.details).toHaveLength(1);
    });

    it('returns error when schedule header does not exist', async () => {
      dataSource.query.mockResolvedValueOnce([]); // Not found

      const res = await service.getReportScheduleDetails(999);
      expect(res.success).toBe(false);
      expect(res.error).toBe('Schedule not found');
    });
  });

  describe('createReportSchedule', () => {
    it('creates new schedule header and inserts detail rows within a transaction', async () => {
      queryRunner.query
        .mockResolvedValueOnce([{ id: 5 }]) // Header insert RETURNING id
        .mockResolvedValueOnce([]); // Detail insert

      const dto = {
        schedule_name: 'New Schedule',
        template_name: 'Default Template',
        report_type: 'PL',
        details: [
          { particulars: 'Salaries', code_from: 'E1001', code_to: 'E1005' },
        ],
      };

      const res = await service.createReportSchedule(dto);

      expect(res.success).toBe(true);
      expect(res.data.id).toBe(5);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('rolls back transaction on error and returns failure', async () => {
      queryRunner.query.mockRejectedValueOnce(new Error('DB failure'));

      const res = await service.createReportSchedule({
        schedule_name: 'Fail Schedule',
        template_name: 'T',
        report_type: 'BS',
        details: [],
      });

      expect(res.success).toBe(false);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('getBalanceSheet', () => {
    it('groups accounts into Assets and Liabilities and calculates differences', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          head_code: 'L1001',
          head_name: 'Share Capital',
          maincd: 1, // Liability
          opening_balance: '10000',
          debit: '0',
          credit: '5000',
          closingbalance: '15000',
        },
        {
          head_code: 'A1001',
          head_name: 'Cash in Hand',
          maincd: 2, // Asset
          opening_balance: '8000',
          debit: '7000',
          credit: '0',
          closingbalance: '15000',
        },
      ]);

      const res = await service.getBalanceSheet('2026-09-30');

      expect(res.success).toBe(true);
      expect(res.data.liabilities).toHaveLength(1);
      expect(res.data.assets).toHaveLength(1);
      expect(res.data.totals.totalLiabilities).toBe(15000);
      expect(res.data.totals.totalAssets).toBe(15000);
      expect(res.data.totals.difference).toBe(0);
    });

    it('ES-332: the net surplus of income over expense is carried on the liability side so the sheet can balance', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          { head_code: 'L1001', head_name: 'Share Value', maincd: 1, opening_balance: '-100', debit: '10', credit: '60', closingbalance: '150' },
          { head_code: 'A1001', head_name: 'Cash', maincd: 2, opening_balance: '100', debit: '90', credit: '0', closingbalance: '190' },
        ])
        .mockResolvedValueOnce([{ net_result: '40' }]);
      const res = await service.getBalanceSheet('2026-09-30');
      expect(res.data.liabilities.map((r: any) => r.headCode)).toEqual(['L1001', 'PL-NET']);
      expect(res.data.liabilities[0].openingBalance).toBe(100); // natural side: opening + credit - debit = closing
      expect(res.data.totals).toMatchObject({ totalLiabilities: 190, totalAssets: 190, netResult: 40, difference: 0 });
    });
    it('ES-332: a net deficit is carried on the asset side', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          { head_code: 'L1001', head_name: 'Share Value', maincd: 1, opening_balance: '-100', debit: '0', credit: '0', closingbalance: '100' },
          { head_code: 'A1001', head_name: 'Cash', maincd: 2, opening_balance: '70', debit: '0', credit: '0', closingbalance: '70' },
        ])
        .mockResolvedValueOnce([{ net_result: '-30' }]);
      const res = await service.getBalanceSheet('2026-09-30');
      expect(res.data.assets.map((r: any) => r.headCode)).toEqual(['A1001', 'PL-NET']);
      expect(res.data.totals).toMatchObject({ totalLiabilities: 100, totalAssets: 100, netResult: -30, difference: 0 });
    });
    it('ES-332: the net result ignores the zero-suppress filters (second query has no WHERE filter)', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.getBalanceSheet('2026-09-30', false, false);
      const second = dataSource.query.mock.calls[1][0] as string;
      expect(second).not.toContain('ABS(closingbalance) > 0.004');
    });
    it('ES-332: a date that is not a real YYYY-MM-DD date is refused (was 200 for today)', async () => {
      await expect(service.getBalanceSheet('not-a-date')).rejects.toThrow(/YYYY-MM-DD/);
      await expect(service.getBalanceSheet('2026-13-45')).rejects.toThrow(/YYYY-MM-DD/);
    });

    it('supports suppressing zero closing balance or zero transaction accounts', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      await service.getBalanceSheet('2026-09-30', false, false);

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('ABS(closingbalance) > 0.004'),
        ['2026-09-30'],
      );
    });
  });
});
