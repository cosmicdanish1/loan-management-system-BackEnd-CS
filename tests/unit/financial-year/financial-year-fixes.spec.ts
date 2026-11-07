import { BadRequestException } from '@nestjs/common';
import { FinancialYearService } from '../../../src/modules/admin/services/financial-year.service';

const mk = (found: any = { yearCode: 5, startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), closedAt: null }) => {
  const qb: any = { where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) };
  const repo: any = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(found), create: jest.fn((x) => x), save: jest.fn(async (x) => x), createQueryBuilder: jest.fn(() => qb) };
  const run = jest.fn(async (sql: string, p?: any[]) => (/SELECT code, head_name/.test(sql) ? [{ code: p![0], head_name: 'H' }] : /is_root/.test(sql) ? [{ is_root: false, has_children: false }] : /MAX\(/.test(sql) ? [{ next: '10' }] : []));
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
  return { svc: new FinancialYearService(repo, { query: run, createQueryRunner: () => qr } as any), qr };
};

describe('financial year length (ES-401)', () => {
  it('365 and 366 day years and the usual 1 April to 31 March pass; 10 years, 2 years and a few days do not', async () => {
    for (const [a, b] of [['2026-04-01', '2027-03-31'], ['2027-04-01', '2028-03-31'], ['2028-01-01', '2028-12-31'], ['2026-01-01', '2026-01-28']]) await expect(mk().svc.createFinancialYear(a, b, 'u')).resolves.toBeDefined();
    for (const [a, b] of [['2026-04-01', '2036-03-31'], ['2026-04-01', '2028-03-31'], ['2026-04-01', '2026-04-05'], ['2026-04-01', '2026-04-27']]) await expect(mk().svc.createFinancialYear(a, b, 'u')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('a closed year is not transferred again and no transaction is opened', async () => {
    const t = mk({ yearCode: 5, startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), closedAt: new Date() });
    await expect(t.svc.initiateTransfer(5, 'u')).rejects.toThrow(/already closed/); expect(t.qr.connect).not.toHaveBeenCalled();
  });
});

describe('balance transfer of one crore or more (ES-357)', () => {
  const t0 = (o: any = {}) => ({ fromAccount: 'A1', toAccount: 'A2', amount: 100, ...o });
  it('below one crore posts; one crore and above needs confirmLargeAmount true (not "true", not 1)', async () => {
    await expect(mk().svc.performBalanceTransfer(t0({ amount: 9_999_999.99 }), 'u')).resolves.toMatchObject({ success: true });
    for (const c of [undefined, false, 'true', 1]) { const t = mk(); await expect(t.svc.performBalanceTransfer(t0({ amount: 10_000_000, confirmLargeAmount: c }), 'u')).rejects.toThrow(/needs confirmation/); expect(t.qr.connect).not.toHaveBeenCalled(); }
    await expect(mk().svc.performBalanceTransfer(t0({ amount: 10_000_000, confirmLargeAmount: true }), 'u')).resolves.toMatchObject({ success: true });
  });
});
