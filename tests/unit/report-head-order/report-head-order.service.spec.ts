import { BadRequestException } from '@nestjs/common';
import { ReportHeadOrderService } from '../../../src/modules/report-head-order/report-head-order.service';

describe('ReportHeadOrderService', () => {
  let service: ReportHeadOrderService;
  let dataSource: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
      transaction: jest.fn(async (cb) => {
        const manager = { query: jest.fn().mockResolvedValue([]) };
        return cb(manager);
      }),
    };
    service = new ReportHeadOrderService(dataSource);
  });

  describe('getOrder', () => {
    it('returns heads in configured report order with 1-based sequential positions', async () => {
      dataSource.query.mockResolvedValueOnce([
        { code: ' A1001 ', headName: 'Cash in Hand', headType: 'ASSET', position: 1 },
        { code: 'L1001', headName: 'Savings Deposits', headType: 'LIABILITY', position: 2 },
        { code: 'X9999', headName: null, headType: null, position: 1000000 },
      ]);

      const result = await service.getOrder();

      expect(dataSource.query).toHaveBeenCalled();
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        code: 'A1001',
        headName: 'Cash in Hand',
        headType: 'ASSET',
        position: 1,
      });
      expect(result[1]).toEqual({
        code: 'L1001',
        headName: 'Savings Deposits',
        headType: 'LIABILITY',
        position: 2,
      });
      // Fallback for null headName
      expect(result[2]).toEqual({
        code: 'X9999',
        headName: 'X9999',
        headType: null,
        position: 3,
      });
    });

    it('propagates database error when getOrder query fails', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('connection timeout'));
      await expect(service.getOrder()).rejects.toThrow('connection timeout');
    });
  });

  describe('saveOrder', () => {
    it('saves a clean list of valid head codes inside a transaction', async () => {
      dataSource.query.mockResolvedValueOnce([
        { code: 'A1001' },
        { code: 'L1001' },
        { code: 'E1001' },
      ]);

      let transactionManager: any;
      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        transactionManager = { query: jest.fn().mockResolvedValue([]) };
        return cb(transactionManager);
      });

      const res = await service.saveOrder([' A1001 ', 'L1001', 'E1001']);

      expect(res).toEqual({ saved: 3 });
      expect(transactionManager.query).toHaveBeenCalledWith('DELETE FROM report_head_order');
      expect(transactionManager.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO report_head_order'),
        [['A1001', 'L1001', 'E1001']],
      );
    });

    it('rejects when input is not an array or is empty', async () => {
      await expect(service.saveOrder(null as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.saveOrder([] as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.saveOrder('A1001' as any)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when array contains empty strings or whitespace', async () => {
      await expect(service.saveOrder(['A1001', '   ', 'L1001'])).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.saveOrder(['A1001', null as any])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects duplicate head codes in list', async () => {
      await expect(service.saveOrder(['A1001', 'L1001', 'A1001'])).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.saveOrder(['A1001', ' A1001 '])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown head codes not present in headmaster', async () => {
      dataSource.query.mockResolvedValueOnce([{ code: 'A1001' }]);
      await expect(service.saveOrder(['A1001', 'INVALID_HEAD'])).rejects.toThrow(
        /Unknown head code\(s\): INVALID_HEAD/,
      );
    });
  });

  describe('resetOrder', () => {
    it('fetches all non-empty codes from headmaster and saves them in alphabetic order', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ code: 'A1001' }, { code: 'L1001' }]) // resetOrder SELECT
        .mockResolvedValueOnce([{ code: 'A1001' }, { code: 'L1001' }]); // saveOrder validation SELECT

      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        return cb({ query: jest.fn().mockResolvedValue([]) });
      });

      const res = await service.resetOrder();
      expect(res).toEqual({ saved: 2 });
    });
  });

  describe('rankMap', () => {
    it('returns a Map of trimmed head codes to their numeric position', async () => {
      dataSource.query.mockResolvedValueOnce([
        { code: ' A1001 ', position: 1 },
        { code: 'L1001', position: 5 },
      ]);

      const map = await service.rankMap();
      expect(map.get('A1001')).toBe(1);
      expect(map.get('L1001')).toBe(5);
      expect(map.get('UNKNOWN')).toBeUndefined();
    });
  });

  describe('sortByHeadOrder', () => {
    it('sorts items according to configured head rank, falling back to unordered rank and code', async () => {
      dataSource.query.mockResolvedValueOnce([
        { code: 'B200', position: 1 },
        { code: 'A100', position: 2 },
      ]);

      const items = [
        { id: 1, head: 'Z999' },
        { id: 2, head: 'A100' },
        { id: 3, head: 'B200' },
        { id: 4, head: 'C300' },
        { id: 5, head: ' ' },
      ];

      const sorted = await service.sortByHeadOrder(items, (item) => item.head);

      expect(sorted.map((i) => i.head.trim())).toEqual([
        'B200', // rank 1
        'A100', // rank 2
        '',     // rank UNORDERED, code ''
        'C300', // rank UNORDERED, code C300
        'Z999', // rank UNORDERED, code Z999
      ]);
    });

    it('handles null, undefined and whitespace head codes gracefully', async () => {
      dataSource.query.mockResolvedValueOnce([{ code: 'A100', position: 1 }]);
      const items = [
        { code: null },
        { code: undefined },
        { code: 'A100' },
      ];

      const sorted = await service.sortByHeadOrder(items, (i) => i.code as any);
      expect(sorted[0].code).toBe('A100');
    });
  });
});
