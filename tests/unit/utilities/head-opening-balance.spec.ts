import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { UtilitiesService } from '../../../src/modules/utilities/utilities.service';

// Head Opening Balance (ES-640): year checks, save validation, closed years, apply rules.

type Call = { sql: string; params?: any[] };
interface Opts { years?: Record<number, { closed: boolean }>; heads?: string[]; saved?: number; affected?: number }

const build = (o: Opts = {}) => {
  const years = o.years ?? { 1: { closed: false }, 2: { closed: false }, 3: { closed: true } };
  const heads = o.heads ?? ['L1001', 'A1001', 'A1002', 'E1001'];
  const calls: Call[] = [];
  const answer = async (sql: string, params?: any[], structured?: boolean) => {
    calls.push({ sql, params });
    if (sql.includes('FROM yearend WHERE yearcode = $1')) { const y = years[Number(params![0])]; return y ? [{ yearcode: Number(params![0]), closed: y.closed }] : []; }
    if (sql.includes('FROM yearend WHERE yearcode IS NOT NULL')) return Object.entries(years).map(([k, v]) => ({ yearcode: k, start_date: '2026-04-01', end_date: '2027-03-31', closed: v.closed }));
    if (sql.includes('FROM headmaster WHERE code = ANY')) return (params![0] as string[]).filter(c => heads.includes(c)).map(code => ({ code }));
    if (sql.includes('COUNT(*)::int AS n FROM yearend_head')) return [{ n: o.saved ?? 5 }];
    if (sql.includes('UPDATE headmaster hm') && structured) return { affected: o.affected ?? 4 };
    if (sql.includes('FROM headmaster hm') && sql.includes('LEFT JOIN')) return heads.map(code => ({ code }));
    return [];
  };
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined), startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined), rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined), query: jest.fn(answer),
  };
  const ds: any = { createQueryRunner: jest.fn().mockReturnValue(qr), query: jest.fn(answer) };
  return { svc: new UtilitiesService(ds, {} as any, {} as any), qr, calls };
};

const good = [{ headCode: 'L1001', closingBal: 700 }, { headCode: 'A1001', closingBal: -1000.456 }, { headCode: 'A1002', closingBal: '200.5' as any }];
const writes = (calls: Call[]) => calls.filter(c => c.sql.includes('INSERT INTO yearend_head') || c.sql.includes('DELETE FROM yearend_head'));

describe('financial years list', () => {
  it('tells which years are closed', async () => {
    const { svc } = build();
    const r = await svc.getFinancialYears();
    expect(r.map(y => y.closed)).toEqual([false, false, true]);
    expect(r[0]).toHaveProperty('label');
  });
});

describe('getHeadOpeningBalances', () => {
  it('returns the heads for an existing year', async () => {
    const { svc } = build();
    await expect(svc.getHeadOpeningBalances(2)).resolves.toHaveLength(4);
  });
  it.each([[NaN], [0], [-1]])('year %p is a 400', async (y) => {
    const { svc } = build();
    await expect(svc.getHeadOpeningBalances(y as number)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('a year that does not exist is a 404', async () => {
    const { svc } = build();
    await expect(svc.getHeadOpeningBalances(99)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('saveHeadOpeningBalances', () => {
  it('saves in one transaction: lock, delete the year, one insert, commit; amounts rounded to the paisa', async () => {
    const { svc, calls, qr } = build();
    const r = await svc.saveHeadOpeningBalances(2, good);
    expect(r.success).toBe(true);
    expect(calls.some(c => c.sql.includes('pg_advisory_xact_lock') && c.params![0] === 'yearend_head:2')).toBe(true);
    expect(writes(calls)).toHaveLength(2);
    const ins = calls.find(c => c.sql.includes('INSERT INTO yearend_head'))!;
    expect(ins.params).toEqual([2, ['L1001', 'A1001', 'A1002'], [700, -1000.46, 200.5]]);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('head codes are matched in capitals', async () => {
    const { svc, calls } = build();
    await svc.saveHeadOpeningBalances(2, [{ headCode: ' l1001 ', closingBal: 5 }]);
    expect(calls.find(c => c.sql.includes('INSERT INTO yearend_head'))!.params![1]).toEqual(['L1001']);
  });

  it.each([
    ['no balances', [], /at least one/],
    ['not a list', null, /at least one/],
    ['a head without a code', [{ headCode: '', closingBal: 1 }], /head code/],
    ['a code too long', [{ headCode: 'L10001', closingBal: 1 }], /head code/],
    ['the same head twice', [{ headCode: 'L1001', closingBal: 1 }, { headCode: 'l1001', closingBal: 2 }], /listed twice/],
    ['text instead of a number', [{ headCode: 'L1001', closingBal: 'abc' }], /must be a number/],
    ['an empty string', [{ headCode: 'L1001', closingBal: '' }], /must be a number/],
    ['not a number value', [{ headCode: 'L1001', closingBal: NaN }], /must be a number/],
    ['infinity', [{ headCode: 'L1001', closingBal: Infinity }], /must be a number/],
    ['an absurd amount', [{ headCode: 'L1001', closingBal: 1e14 }], /too large/],
    ['a missing amount', [{ headCode: 'L1001' }], /must be a number/],
  ])('refuses %s with a 400 and writes nothing', async (_n, body, text) => {
    const { svc, calls, qr } = build();
    const p = svc.saveHeadOpeningBalances(2, body as any);
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow(text as RegExp);
    expect(writes(calls)).toHaveLength(0);
    expect(qr.startTransaction).not.toHaveBeenCalled();
  });

  it('more than 2000 balances is refused', async () => {
    const { svc } = build();
    const many = Array.from({ length: 2001 }, (_, i) => ({ headCode: `A${i}`.slice(0, 5), closingBal: 1 }));
    await expect(svc.saveHeadOpeningBalances(2, many)).rejects.toThrow(/Too many/);
  });

  it('an unknown head is a 400 naming it, and the year is left as it was (rolled back)', async () => {
    const { svc, calls, qr } = build();
    await expect(svc.saveHeadOpeningBalances(2, [{ headCode: 'L1001', closingBal: 1 }, { headCode: 'Z9999', closingBal: 1 }])).rejects.toThrow(/Unknown head code: Z9999/);
    expect(writes(calls)).toHaveLength(0);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });

  it('a year that does not exist is a 404; a missing year is a 400', async () => {
    const { svc } = build();
    await expect(svc.saveHeadOpeningBalances(99, good)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.saveHeadOpeningBalances(undefined as any, good)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a closed year cannot be changed (409) and nothing is written', async () => {
    const { svc, calls, qr } = build();
    await expect(svc.saveHeadOpeningBalances(3, good)).rejects.toBeInstanceOf(ConflictException);
    expect(writes(calls)).toHaveLength(0);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('a failed insert rolls back and releases', async () => {
    const { svc, qr } = build();
    const orig = qr.query.getMockImplementation();
    qr.query.mockImplementation(async (sql: string, p: any[]) => { if (sql.includes('INSERT INTO yearend_head')) throw new Error('boom'); return orig(sql, p); });
    await expect(svc.saveHeadOpeningBalances(2, good)).rejects.toThrow(/Failed to save opening balances: boom/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });

  it('stress: 200 saves at once each take the year lock and each commit', async () => {
    const { svc, calls, qr } = build();
    const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => svc.saveHeadOpeningBalances(1 + (i % 2), good)));
    expect(rs.every(r => r.success)).toBe(true);
    expect(calls.filter(c => c.sql.includes('pg_advisory_xact_lock'))).toHaveLength(200);
    expect(qr.commitTransaction).toHaveBeenCalledTimes(200);
  });
});

describe('applyYearOpeningBalances', () => {
  it('applies a saved open year and reports how many heads changed', async () => {
    const { svc, qr } = build({ affected: 4 });
    const r = await svc.applyYearOpeningBalances(2);
    expect(r).toMatchObject({ success: true, updated: 4 });
    expect(qr.commitTransaction).toHaveBeenCalled();
  });
  it('a year with nothing saved is a 400, not "applied 0"', async () => {
    const { svc, calls } = build({ saved: 0 });
    await expect(svc.applyYearOpeningBalances(2)).rejects.toThrow(/Save them first/);
    expect(calls.some(c => c.sql.includes('UPDATE headmaster'))).toBe(false);
  });
  it('a closed year cannot be applied over the live balances (409)', async () => {
    const { svc, calls } = build();
    await expect(svc.applyYearOpeningBalances(3)).rejects.toBeInstanceOf(ConflictException);
    expect(calls.some(c => c.sql.includes('UPDATE headmaster'))).toBe(false);
  });
  it('unknown year is 404, bad year 400; the refusal is rolled back and released', async () => {
    const { svc, qr } = build();
    await expect(svc.applyYearOpeningBalances(99)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.applyYearOpeningBalances(NaN)).rejects.toBeInstanceOf(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });
});
