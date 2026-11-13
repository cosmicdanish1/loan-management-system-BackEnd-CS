import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DividendCalculationService } from '../../../src/modules/dividend/services/dividend-calculation.service';
import { DividendCreditService } from '../../../src/modules/dividend/services/dividend-credit.service';
import { ShareMonthEndService } from '../../../src/modules/dividend/services/share-month-end.service';
import { GroupInsuranceService } from '../../../src/modules/group-insurance/group-insurance.service';

const runnerOf = (route: (sql: string, p?: any[]) => any) => {
  const calls: any[] = [];
  const query = jest.fn(async (sql: string, p?: any[]) => { calls.push([sql, p]); const r = route(sql, p); return r === undefined ? [] : r; });
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query };
  return { qr, ds: { query, createQueryRunner: jest.fn(() => qr) } as any, calls };
};

describe('dividend/DividendCalculationService', () => {
  const fyRow = [{ start_date: '2026-04-01', end_date: '2027-03-31' }];
  const mk = (rows: any[] = [], fy: any[] = fyRow) => runnerOf((sql) => (/FROM yearend/.test(sql) ? fy : /FROM share_monthly_balance/.test(sql) ? rows : /INSERT INTO dividend_master/.test(sql) ? [{ mbno: 'x' }] : undefined));
  it('a financial year has 12 months from April to March', async () => {
    const m = await new DividendCalculationService(mk().ds).getFinancialYearMonths(3);
    expect(m).toHaveLength(12); expect(m[0]).toEqual({ month: 4, year: 2026 }); expect(m[11]).toEqual({ month: 3, year: 2027 });
  });
  it('unknown year: 404', async () => { await expect(new DividendCalculationService(mk([], []).ds).getFinancialYearMonths(9)).rejects.toThrow(NotFoundException); });
  it('dividend = sum of 12 month-end share balances x rate / 1200', async () => {
    const t = mk([{ mbno: '5', member_name: ' A B ', months_found: 12, total_product: '120000' }]);
    const r = await new DividendCalculationService(t.ds).previewDividendForYear(3, 10);
    expect(r).toMatchObject({ calculationYear: 2026, monthsExpected: 12 }); expect(r.members[0]).toMatchObject({ mbno: '5', memberName: 'A B', totalProduct: 120000, monthsFound: 12, dividendAmount: 1000 });
  });
  it('rounds to paise', async () => {
    const r = await new DividendCalculationService(mk([{ mbno: '5', months_found: 12, total_product: '1000.55' }]).ds).previewDividendForYear(3, 7.5);
    expect(r.members[0].dividendAmount).toBe(6.25);
  });
  it('rate 0, negative, NaN and a rate over 100% are refused', async () => {
    for (const rate of [0, -1, NaN, 500, 100.5]) await expect(new DividendCalculationService(mk().ds).previewDividendForYear(3, rate)).rejects.toThrow(BadRequestException);
  });
  it('a member with fewer than 12 monthly snapshots is reported with monthsFound', async () => {
    const r = await new DividendCalculationService(mk([{ mbno: '5', months_found: 7, total_product: '1000' }]).ds).previewDividendForYear(3, 10); expect(r.members[0].monthsFound).toBe(7); expect(r.members[0].monthsExpected).toBe(12);
  });
  it('the snapshot month and year conditions are bound parameters (24 values)', async () => {
    const t = mk(); await new DividendCalculationService(t.ds).previewDividendForYear(3, 10);
    const q = t.calls.find((c) => /FROM share_monthly_balance/.test(c[0])); expect(q[1]).toHaveLength(24); expect(q[1].slice(0, 2)).toEqual([4, 2026]);
  });
  it('commit writes one row per member in one transaction, never overwriting a paid dividend', async () => {
    const t = mk([{ mbno: '5', months_found: 12, total_product: '1200' }, { mbno: '6', months_found: 12, total_product: '2400' }]);
    const r = await new DividendCalculationService(t.ds).commitDividendForYear(3, 10);
    const ins = t.calls.filter((c) => /INSERT INTO dividend_master/.test(c[0])); expect(r).toEqual({ success: true, calculationYear: 2026, membersCommitted: 2 }); expect(ins).toHaveLength(2);
    expect(ins[0][0]).toContain("dividend_master.is_paid != 'Y'"); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('ES-498: membersCommitted counts only the rows really written (credited / paid rows return nothing)', async () => {
    const t = runnerOf((sql, p) => { if (/FROM yearend/.test(sql)) return fyRow; if (/FROM share_monthly_balance/.test(sql)) return [{ mbno: '5', months_found: 12, total_product: '1200' }, { mbno: '6', months_found: 12, total_product: '2400' }]; if (/INSERT INTO dividend_master/.test(sql)) return p![0] === '5' ? [] : [{ mbno: '6' }]; return undefined; });
    const r = await new DividendCalculationService(t.ds).commitDividendForYear(3, 10);
    expect(r.membersCommitted).toBe(1);
  });
  it('commit rolls back when an insert fails', async () => {
    const t = runnerOf((sql) => { if (/INSERT INTO dividend_master/.test(sql)) throw new Error('x'); if (/credited_at IS NOT NULL OR is_paid/.test(sql)) return []; return /FROM yearend/.test(sql) ? fyRow : [{ mbno: '5', months_found: 12, total_product: '1200' }]; });
    await expect(new DividendCalculationService(t.ds).commitDividendForYear(3, 10)).rejects.toThrow('x'); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('commit refuses a rate of 500%', async () => { await expect(new DividendCalculationService(mk().ds).commitDividendForYear(3, 500)).rejects.toThrow(BadRequestException); });
});

describe('dividend/DividendCreditService', () => {
  const seq: any = { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH001'), getNextVoucherId: jest.fn().mockResolvedValue(8) };
  const years = (sql: string, p?: any[]) => (/SELECT start_date FROM yearend WHERE yearcode/.test(sql) ? [{ start_date: p![0] === 4 ? '2027-04-01' : '2026-04-01' }] : /FROM yearend WHERE start_date </.test(sql) ? [{ yearcode: 3, start_date: '2026-04-01' }] : undefined);
  it('previous year of the first year is null; unknown year 404', async () => {
    const a = runnerOf((sql) => (/SELECT start_date FROM yearend WHERE yearcode/.test(sql) ? [{ start_date: '2026-04-01' }] : [])); expect(await new DividendCreditService(a.ds, seq).getPreviousYearcode(1)).toBeNull();
    await expect(new DividendCreditService(runnerOf(() => []).ds, seq).getPreviousYearcode(9)).rejects.toThrow(NotFoundException);
  });
  it('preview: new share value = current + dividend', async () => {
    const t = runnerOf((sql, p) => years(sql, p) ?? (/FROM dividend_master dm/.test(sql) ? [{ mbno: '5', member_name: 'A', dividend_amount: '250.5', current_share_value: '1000' }] : undefined));
    const r = await new DividendCreditService(t.ds, seq).previewCreditForYear(4);
    expect(r).toMatchObject({ creditYearcode: 4, previousCalculationYear: 2026 }); expect(r.members[0]).toMatchObject({ dividendAmount: 250.5, newShareValue: 1250.5 });
  });
  it('credit: nothing to credit gives null and rolls back', async () => {
    const t = runnerOf((sql, p) => years(sql, p)); expect(await new DividendCreditService(t.ds, seq).creditMemberDividend('5', 4, 'u')).toBeNull(); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
  const credit = (o: { amount?: any; pflag?: string; updateRows?: any } = {}) => runnerOf((sql, p) => years(sql, p)
    ?? (/FROM dividend_master/.test(sql) && /FOR UPDATE/.test(sql) ? [{ id: 1, dividend_amount: o.amount ?? '250' }]
      : /SELECT pflag FROM headmaster/.test(sql) ? [{ pflag: o.pflag ?? 'L' }]
      : /MAX\(ledgerid\)/.test(sql) ? [{ next_id: 10 }]
      : /UPDATE member_balances/.test(sql) ? (o.updateRows ?? [[{ mbno: 5 }], 1])
      : /SELECT shares FROM member_balances/.test(sql) ? [{ shares: '1250' }] : undefined));
  it('credit posts a balanced voucher: payable debited, share credited (liability heads), balance and marker updated, one commit', async () => {
    const t = credit(); const r = await new DividendCreditService(t.ds, seq).creditMemberDividend('5', 4, 'bob');
    const led = t.calls.filter((c) => /INSERT INTO ledger/.test(c[0]));
    expect(r).toEqual({ mbno: '5', calculationYear: 2026, dividendAmount: 250, newShareValue: 1250 });
    expect(led).toHaveLength(2); expect(led[0][1][0]).toBe('DR'); expect(led[0][1][1]).toBe('L1024'); expect(led[1][1][0]).toBe('CR'); expect(led[1][1][1]).toBe('L1001'); expect(led[0][1][3]).toBe(led[1][1][3]);
    expect(t.calls.some((c) => /UPDATE dividend_master SET credited_at/.test(c[0]))).toBe(true); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('the dividend row is locked (FOR UPDATE) and only an uncredited, unpaid one is taken, so it cannot be credited twice', async () => {
    const t = credit(); await new DividendCreditService(t.ds, seq).creditMemberDividend('5', 4, 'u');
    const q = t.calls.find((c) => /FOR UPDATE/.test(c[0]))[0]; expect(q).toContain('credited_at IS NULL'); expect(q).toContain("is_paid != 'Y'");
  });
  it('a member without a member_balances row is not marked credited while the share balance was never increased', async () => {
    const t = credit({ updateRows: [[], 0] }); await expect(new DividendCreditService(t.ds, seq).creditMemberDividend('5', 4, 'u')).rejects.toThrow();
  });
  it('a failure rolls back and releases', async () => {
    const t = runnerOf((sql, p) => { if (/INSERT INTO ledger/.test(sql)) throw new Error('x'); return years(sql, p) ?? (/FOR UPDATE/.test(sql) ? [{ id: 1, dividend_amount: '5' }] : /MAX\(ledgerid\)/.test(sql) ? [{ next_id: 1 }] : undefined); });
    await expect(new DividendCreditService(t.ds, seq).creditMemberDividend('5', 4, 'u')).rejects.toThrow('x'); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('creditAll continues after a member fails and lists the failures', async () => {
    const svc: any = new DividendCreditService(credit().ds, seq);
    svc.previewCreditForYear = jest.fn().mockResolvedValue({ members: [{ mbno: '1' }, { mbno: '2' }, { mbno: '3' }] });
    svc.creditMemberDividend = jest.fn().mockResolvedValueOnce({ mbno: '1' }).mockRejectedValueOnce(new Error('bad')).mockResolvedValueOnce(null);
    expect(await svc.creditAllForYear(4, 'u')).toEqual({ creditYearcode: 4, credited: [{ mbno: '1' }], failed: [{ mbno: '2', error: 'bad' }] });
  });
});

describe('dividend/ShareMonthEndService', () => {
  const mk = (rows: any[] = []) => runnerOf((sql) => (/FROM member_balances/.test(sql) ? rows : undefined));
  it('captures one row per member with shares and commits', async () => {
    const t = mk([{ mbno: '5', shares: '1000.5' }, { mbno: '6', shares: null }]); const r = await new ShareMonthEndService(t.ds).captureMonthEndSnapshot(3, 2026);
    expect(r).toEqual({ success: true, captured: 2, message: 'Captured 2 member Share balances for 3/2026' }); expect(t.calls.filter((c) => /INSERT INTO share_monthly_balance/.test(c[0]))[0][1]).toEqual(['5', 3, 2026, 1000.5]);
  });
  it('re-running a month overwrites it', async () => {
    const t = mk([{ mbno: '5', shares: '1' }]); await new ShareMonthEndService(t.ds).captureMonthEndSnapshot(3, 2026); expect(t.calls.find((c) => /INSERT INTO share_monthly_balance/.test(c[0]))[0]).toContain('ON CONFLICT (mbno, snapshot_month, snapshot_year) DO UPDATE');
  });
  it('month 13, month 0, year 1800 and a non numeric month are refused', async () => {
    for (const [m, y] of [[13, 2026], [0, 2026], [3, 1800], ['abc', 2026]]) await expect(new ShareMonthEndService(mk([{ mbno: '5', shares: '1' }]).ds).captureMonthEndSnapshot(m as any, y as number)).rejects.toThrow();
  });
  it('a failure rolls back and wraps the message', async () => {
    const t = runnerOf((sql) => { if (/INSERT/.test(sql)) throw new Error('x'); return [{ mbno: '5', shares: '1' }]; });
    await expect(new ShareMonthEndService(t.ds).captureMonthEndSnapshot(3, 2026)).rejects.toThrow('Share month-end snapshot failed: x'); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
  it('reports read with bound parameters', async () => {
    const t = mk(); const s = new ShareMonthEndService(t.ds); await s.getMonthlyBalanceReport(3, 2026); await s.getMemberBalanceHistory("5' OR 1=1");
    expect(t.calls[0][1]).toEqual([3, 2026]); expect(t.calls[1][1]).toEqual(["5' OR 1=1"]);
  });
});

describe('group-insurance/GroupInsuranceService', () => {
  const yearRow = [{ yearcode: 3, fy_start: '2026-04-01', fy_end: '2027-03-31' }];
  const mk = (o: { year?: any[]; done?: any[]; agg?: any } = {}) => runnerOf((sql) => {
    if (/FROM yearend WHERE yearcode/.test(sql)) return o.year ?? yearRow;
    if (/FROM group_insurance_run WHERE yearcode/.test(sql)) return o.done ?? [];
    if (/FROM _gi_calc/.test(sql) && /count\(\*\)::int AS members/.test(sql)) return [o.agg ?? { members: 2, total: '600', n: 2, per_member: '300' }];
    if (/voucher_master/.test(sql) && /ORDER BY/.test(sql)) return [{ last: 'J00009' }];
    if (/SELECT 1 WHERE EXISTS/.test(sql)) return [];
    if (/INSERT INTO group_insurance_run/.test(sql)) return [{ id: 11 }];
    if (/MAX\(trans_no\)/.test(sql)) return [{ max_trans: 100 }];
    if (/MAX\(ledgerid\)/.test(sql)) return [{ max_id: 200 }];
    return undefined;
  });
  const post = (t: any, o: any = {}) => new GroupInsuranceService(t.ds).post({ yearcode: 3, lumpSum: 100000, ...o }, 'bob');
  it('validation: the year must be a whole number and the lump sum a positive amount up to 1e9', async () => {
    for (const o of [{ yearcode: 'x' }, { yearcode: 3.5 }, { lumpSum: 0 }, { lumpSum: -1 }, { lumpSum: NaN }, { lumpSum: 2e9 }, { lumpSum: 'abc' }]) await expect(post(mk(), o)).rejects.toThrow(BadRequestException);
  });
  it('unknown year: 404', async () => { await expect(post(mk({ year: [] }))).rejects.toThrow(NotFoundException); });
  it('the posting date must be YYYY-MM-DD and inside the financial year', async () => {
    await expect(post(mk(), { postingDate: '31/03/2027' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(post(mk(), { postingDate: '2028-01-01' })).rejects.toThrow(/inside the financial year/); await expect(post(mk(), { postingDate: '2026-03-31' })).rejects.toThrow(/inside the financial year/);
    await expect(post(mk(), { postingDate: '2027-03-31' })).resolves.toBeDefined();
  });
  it('a year that is already posted cannot be posted twice', async () => { await expect(post(mk({ done: [{ id: 1 }] }))).rejects.toThrow(ConflictException); });
  it('nobody to charge: 400', async () => { await expect(post(mk({ agg: { members: 0, total: '0', n: 0, per_member: '0' } }))).rejects.toThrow(/nobody to charge/); });
  it('takes the advisory locks before the already-posted check', async () => {
    const t = mk(); await post(t); const lock = t.calls.findIndex((c) => /pg_advisory_xact_lock/.test(c[0])); const chk = t.calls.findIndex((c) => /FROM group_insurance_run WHERE yearcode/.test(c[0]));
    expect(lock).toBe(0); expect(lock).toBeLessThan(chk);
  });
  it('posts run, charges, DR RD / CR insurance ledger rows, balances and cashbook in one transaction', async () => {
    const t = mk(); const r = await post(t);
    expect(r).toEqual({ runId: 11, voucherNo: 'J00010', fyLabel: '2026-27', membersCharged: 2, totalCharged: 600 });
    const sql = t.calls.map((c) => c[0]).join('\n'); for (const s of ["'DR', 'L1004'", "'CR', 'L1003'", 'INSERT INTO group_insurance_charge', 'UPDATE member_balances', 'INSERT INTO tblcashbook']) expect(sql).toContain(s);
    expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('a failure rolls back and releases', async () => {
    const t = runnerOf((sql) => { if (/INSERT INTO group_insurance_run/.test(sql)) throw new Error('x'); return /FROM yearend/.test(sql) ? yearRow : /count\(\*\)::int AS members/.test(sql) ? [{ members: 2, total: '1', n: 2, per_member: '1' }] : /voucher_master/.test(sql) ? [{ last: 'J1' }] : []; });
    await expect(post(t)).rejects.toThrow('x'); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('preview: search text is a bound parameter and the page size is capped at 500', async () => {
    const t = runnerOf((sql) => (/FROM yearend WHERE yearcode/.test(sql) ? yearRow : /count\(\*\)::int AS members/.test(sql) ? [{ members: 0, n: 0, per_member: 0, total: 0 }] : /active_total/.test(sql) ? [{ active_total: 0 }] : /count\(\*\)::int AS total/.test(sql) ? [{ total: 0 }] : []));
    await new GroupInsuranceService(t.ds).preview({ yearcode: 3, lumpSum: 1000, search: "x' OR 1=1", limit: 99999 });
    const rows = t.calls.find((c) => /ORDER BY mbno LIMIT/.test(c[0])); expect(rows[0]).toContain('LIMIT 500'); expect(rows[1]).toContain("%x' OR 1=1%"); expect(rows[0]).not.toContain("OR 1=1");
  });
  it('runDetail: unknown run 404', async () => { await expect(new GroupInsuranceService(runnerOf(() => []).ds).runDetail(99)).rejects.toThrow(NotFoundException); });
  it('context: current year is the one containing today, else the newest', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const t = runnerOf((sql) => (/FROM yearend ORDER BY/.test(sql) ? [{ yearcode: 5, fy_start: '2026-04-01', fy_end: '2027-03-31', closed_at: null }, { yearcode: 4, fy_start: '2025-04-01', fy_end: '2026-03-31', closed_at: 'x' }] : []));
    const c = await new GroupInsuranceService(t.ds).context(); expect(c.today).toBe(today); expect(c.years[1]).toMatchObject({ yearcode: 4, closed: true, label: '2025-26' });
  });
});
