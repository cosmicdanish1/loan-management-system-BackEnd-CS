import { BadRequestException } from '@nestjs/common';
import { DividendCalculationService } from '../../../src/modules/dividend/services/dividend-calculation.service';
import { ShareMonthEndService } from '../../../src/modules/dividend/services/share-month-end.service';

const ds = () => { const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn(async () => []) }; return { qr, ds: { createQueryRunner: () => qr, query: jest.fn(async () => []) } as any }; };

describe('dividend rate range (ES-328)', () => {
  it('0 < rate <= 100 passes the check (an unknown year then gives 404, not 400)', async () => {
    for (const r of [0.01, 10, 100, '12' as any]) await expect(new DividendCalculationService(ds().ds).previewDividendForYear(1, r)).rejects.not.toBeInstanceOf(BadRequestException);
  });
  it('0, negative, text, NaN, Infinity and above 100 are refused before any query; commit too', async () => {
    for (const r of [0, -1, 'abc' as any, NaN, Infinity, 100.01, 500]) {
      const d = ds();
      await expect(new DividendCalculationService(d.ds).previewDividendForYear(1, r)).rejects.toBeInstanceOf(BadRequestException);
      await expect(new DividendCalculationService(d.ds).commitDividendForYear(1, r)).rejects.toBeInstanceOf(BadRequestException);
      expect(d.ds.query).not.toHaveBeenCalled();
      expect(d.qr.startTransaction).not.toHaveBeenCalled();
    }
  });
});

describe('share month-end snapshot input (ES-370)', () => {
  const cap = (m: any, y: any) => { const d = ds(); return { d, p: new ShareMonthEndService(d.ds).captureMonthEndSnapshot(m, y) }; };
  it('bad month or year is a 400 and no transaction is started', async () => {
    for (const [m, y] of [[13, 2026], [0, 2026], [-1, 2026], [1.5, 2026], ['abc', 2026], [3, 1800], [3, 2101], [3, 'x'], [3, 2026.5], [null, 2026], [undefined, 2026]]) {
      const { d, p } = cap(m, y);
      await expect(p).rejects.toBeInstanceOf(BadRequestException);
      expect(d.qr.startTransaction).not.toHaveBeenCalled();
    }
  });
  it('1..12 and 1900..2100 (numbers sent as text too) are accepted and bound as numbers', async () => {
    for (const [m, y] of [[1, 1900], [12, 2100], ['3', '2026']]) await expect(cap(m, y).p).resolves.toMatchObject({ success: true });
    const { d, p } = cap('3', '2026'); await p;
    expect(d.qr.query.mock.calls.length).toBe(1);
  });
});
