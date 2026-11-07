import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FinancialYearService } from '../../../src/modules/admin/services/financial-year.service';

const fy = (o: any = {}) => ({ yearCode: 5, startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), closedAt: null, ...o });

function mk(opts: { current?: any; found?: any; overlap?: any; last?: any[]; q?: (sql: string, params?: any[]) => any } = {}) {
  const qb: any = { where: jest.fn().mockReturnThis(), getOne: jest.fn() };
  const repo: any = {
    find: jest.fn().mockResolvedValue(opts.last ?? []), findOne: jest.fn().mockResolvedValue(opts.found === undefined ? fy() : opts.found),
    create: jest.fn((x) => x), save: jest.fn(async (x) => x), update: jest.fn(), delete: jest.fn(),
    createQueryBuilder: jest.fn(() => qb),
  };
  qb.getOne.mockImplementation(async () => (qb.where.mock.calls.some((c: any[]) => /:now/.test(c[0])) ? (opts.current ?? null) : (opts.overlap ?? null)));
  const calls: any[] = [];
  const route = opts.q ?? (() => []);
  const run = jest.fn(async (sql: string, params?: any[]) => { calls.push([sql, params]); return route(sql, params) ?? []; });
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
  const ds: any = { query: run, createQueryRunner: jest.fn(() => qr) };
  return { svc: new FinancialYearService(repo, ds), repo, qr, ds, calls };
}

describe('financial-year/createFinancialYear', () => {
  it('rejects invalid dates', async () => { await expect(mk().svc.createFinancialYear('x', '2027-03-31', 'u')).rejects.toThrow(/valid dates/); });
  it('rejects start on or after end', async () => {
    await expect(mk().svc.createFinancialYear('2027-03-31', '2026-04-01', 'u')).rejects.toThrow(/before end/);
    await expect(mk().svc.createFinancialYear('2026-04-01', '2026-04-01', 'u')).rejects.toThrow(/before end/);
  });
  it('rejects an overlapping period and names the clashing year', async () => {
    await expect(mk({ overlap: fy({ yearCode: 4 }) }).svc.createFinancialYear('2026-01-01', '2026-12-31', 'u')).rejects.toThrow(/overlaps with existing Financial Year 4/);
  });
  it('numbers the new year after the last one, starting at 1', async () => {
    const a = mk({ last: [{ yearCode: 9 }] }); await a.svc.createFinancialYear('2026-04-01', '2027-03-31', 'u');
    expect(a.repo.create.mock.calls[0][0].yearCode).toBe(10);
    const b = mk(); await b.svc.createFinancialYear('2026-04-01', '2027-03-31', 'u');
    expect(b.repo.create.mock.calls[0][0].yearCode).toBe(1);
  });
  it('a period longer than one year (or only a few days) is not accepted as a financial year', async () => {
    await expect(mk().svc.createFinancialYear('2026-04-01', '2036-03-31', 'u')).rejects.toThrow(BadRequestException);
  });
});

describe('financial-year/get / close / delete', () => {
  it('getFinancialYear 404', async () => { await expect(mk({ found: null }).svc.getFinancialYear(9)).rejects.toThrow(NotFoundException); });
  it('close: sets closedAt and user', async () => {
    const t = mk(); await t.svc.closeFinancialYear(5, 'u');
    expect(t.repo.update.mock.calls[0][1]).toMatchObject({ username: 'u' }); expect(t.repo.update.mock.calls[0][1].closedAt).toBeInstanceOf(Date);
  });
  it('close: refuses an already closed year', async () => {
    await expect(mk({ found: fy({ closedAt: new Date() }) }).svc.closeFinancialYear(5, 'u')).rejects.toThrow(/already closed/);
  });
  it('delete: refuses a closed year', async () => {
    await expect(mk({ found: fy({ closedAt: new Date() }) }).svc.deleteFinancialYear(5)).rejects.toThrow(/closed and cannot be deleted/);
  });
  it('delete: refuses archived years unless forced', async () => {
    const t = mk({ q: (sql) => (/COUNT/.test(sql) ? [{ cnt: '3' }] : []) });
    await expect(t.svc.deleteFinancialYear(5)).rejects.toThrow(/force=true/); expect(t.repo.delete).not.toHaveBeenCalled();
  });
  it('delete with force removes archive rows and the year', async () => {
    const t = mk({ q: (sql) => (/COUNT/.test(sql) ? [{ cnt: '3' }] : []) });
    await t.svc.deleteFinancialYear(5, true);
    const sqls = t.calls.map((c) => c[0]).join('\n');
    expect(sqls).toContain('DELETE FROM yearend_head'); expect(sqls).toContain('DELETE FROM bankopbal'); expect(t.repo.delete).toHaveBeenCalledWith({ yearCode: 5 });
  });
  it('delete of a clean year just deletes it', async () => {
    const t = mk({ q: (sql) => (/COUNT/.test(sql) ? [{ cnt: '0' }] : []) });
    expect(await t.svc.deleteFinancialYear(5)).toEqual({ message: 'Financial Year 5 deleted.' });
  });
});

describe('financial-year/initiateTransfer (closing balances)', () => {
  const heads = [
    { head_code: 'A1', parent_code: null, pflag: 'A', op_bal: '100', total_dr: '50', total_cr: '30' },
    { head_code: 'L1', parent_code: null, pflag: 'L', op_bal: '100', total_dr: '50', total_cr: '30' },
    { head_code: 'I1', parent_code: null, pflag: 'I', op_bal: '0', total_dr: '0', total_cr: '70' },
    { head_code: 'E1', parent_code: null, pflag: 'E', op_bal: '0', total_dr: '40', total_cr: '0' },
  ];
  const q = (sql: string) => (/FROM headmaster hm/.test(sql) ? heads : /MAX\(trfid\)/.test(sql) ? [{ max: '0' }] : []);
  it('asset/expense closing = op + dr - cr; liability/income = op + cr - dr', async () => {
    const t = mk({ q }); await t.svc.initiateTransfer(5, 'u');
    const ins = t.calls.filter((c) => /INSERT INTO yearend_head/.test(c[0])).map((c) => [c[1][1], c[1][3]]);
    expect(ins).toEqual([['A1', 120], ['L1', 80], ['I1', 70], ['E1', 40]]);
  });
  it('archives loans, CD, MD, SHR and SB balances and commits once', async () => {
    const t = mk({ q: (sql) => (/FROM headmaster hm/.test(sql) ? heads : /FROM loan_master/.test(sql) ? [{ acc_type: 'RLN', mbno: '1', balance: '500' }] : /FROM fundsmaster/.test(sql) ? [{ mbno: '1', cd_bal: '10', md_bal: '0', shr_bal: '5' }] : /FROM sbmaster/.test(sql) ? [{ mbno: '1', sb_bal: '7' }] : /MAX\(trfid\)/.test(sql) ? [{ max: '0' }] : []) });
    const r = await t.svc.initiateTransfer(5, 'u');
    const types = t.calls.filter((c) => /INSERT INTO yearend_member/.test(c[0])).map((c) => c[0].match(/'(CD|MD|SHR|SB)'/)?.[1] ?? c[1][1]);
    expect(types).toEqual(['RLN', 'CD', 'SHR', 'SB']); expect(r.message).toContain('4 member balances'); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('re-running the transfer first clears the previous archive of that year', async () => {
    const t = mk({ q }); await t.svc.initiateTransfer(5, 'u');
    expect(t.calls.some((c) => /DELETE FROM yearend_head WHERE yearcode/.test(c[0]))).toBe(true);
  });
  it('a failure rolls the whole transfer back and is reported as 400', async () => {
    const t = mk({ q: (sql) => { if (/INSERT INTO yearend_head/.test(sql)) throw new Error('boom'); return /FROM headmaster hm/.test(sql) ? heads : []; } });
    await expect(t.svc.initiateTransfer(5, 'u')).rejects.toThrow(/Year-end transfer failed: boom/);
    expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('404 for an unknown year (nothing started)', async () => {
    const t = mk({ found: null }); await expect(t.svc.initiateTransfer(9, 'u')).rejects.toThrow(NotFoundException);
    expect(t.qr.connect).not.toHaveBeenCalled();
  });
  it('a closed year cannot be transferred again', async () => {
    await expect(mk({ found: fy({ closedAt: new Date() }) }).svc.initiateTransfer(5, 'u')).rejects.toThrow(BadRequestException);
  });
});

describe('financial-year/performBalanceTransfer', () => {
  const heads = (sql: string, p?: any[]) => (/SELECT code, head_name/.test(sql) ? [{ code: p![0], head_name: 'H' }] : /is_root/.test(sql) ? [{ is_root: false, has_children: false }] : /MAX\(trans_no/.test(sql) ? [{ next: '10' }] : /MAX\(ledgerid/.test(sql) ? [{ next: '20' }] : []);
  const t0 = (o: any = {}) => ({ fromAccount: 'A1', toAccount: 'A2', amount: 100, ...o });
  it.each([[0], [-5], ['abc'], [NaN], [Infinity], [undefined]])('rejects amount %p', async (amount) => {
    await expect(mk({ q: heads }).svc.performBalanceTransfer(t0({ amount }), 'u')).rejects.toThrow(/amount must be a number greater than zero/);
  });
  it('rejects missing accounts and identical accounts', async () => {
    await expect(mk({ q: heads }).svc.performBalanceTransfer(t0({ fromAccount: '' }), 'u')).rejects.toThrow(/required/);
    await expect(mk({ q: heads }).svc.performBalanceTransfer(t0({ toAccount: ' A1 ' }), 'u')).rejects.toThrow(/must be different/);
  });
  it('rejects an invalid date', async () => {
    await expect(mk({ q: heads }).svc.performBalanceTransfer(t0({ transferDate: 'zzz' }), 'u')).rejects.toThrow(/not a valid date/);
  });
  it('rejects an unknown account and rolls back', async () => {
    const t = mk({ q: (sql, p) => (/SELECT code, head_name/.test(sql) && p![0] === 'A2' ? [] : heads(sql, p)) });
    await expect(t.svc.performBalanceTransfer(t0(), 'u')).rejects.toThrow(/Account A2 not found/); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
  it('rejects a group head (root or with children)', async () => {
    const t = mk({ q: (sql, p) => (/is_root/.test(sql) ? [{ is_root: false, has_children: true }] : heads(sql, p)) });
    await expect(t.svc.performBalanceTransfer(t0(), 'u')).rejects.toThrow(/group head/);
  });
  it('posts a balanced DR / CR pair with consecutive numbers and rounds the amount to paise', async () => {
    const t = mk({ q: heads }); const r = await t.svc.performBalanceTransfer(t0({ amount: 100.456 }), 'u');
    const ins = t.calls.filter((c) => /INSERT INTO ledger/.test(c[0]));
    expect(r.success).toBe(true); expect(ins).toHaveLength(2);
    expect(ins[0][0]).toContain("'DR'"); expect(ins[1][0]).toContain("'CR'");
    expect(ins[0][1][4]).toBe(100.46); expect(ins[1][1][4]).toBe(100.46);
    expect(ins[0][1][3]).toBe('A1'); expect(ins[1][1][3]).toBe('A2'); expect(ins[1][1][1]).toBe(ins[0][1][1] + 1);
    expect(t.qr.commitTransaction).toHaveBeenCalled();
  });
  it('takes an advisory lock before reading the maximum numbers', async () => {
    const t = mk({ q: heads }); await t.svc.performBalanceTransfer(t0(), 'u');
    const lock = t.calls.findIndex((c) => /pg_advisory_xact_lock/.test(c[0])); const max = t.calls.findIndex((c) => /MAX\(trans_no/.test(c[0]));
    expect(lock).toBeGreaterThan(-1); expect(lock).toBeLessThan(max);
  });
  it('an amount of one crore or more asks for confirmation instead of posting silently', async () => {
    await expect(mk({ q: heads }).svc.performBalanceTransfer(t0({ amount: 1e12 }), 'u')).rejects.toThrow(BadRequestException);
  });
});

describe('financial-year/closing preview and P&L year end', () => {
  it('preview: totals and net profit, reserve head', async () => {
    const t = mk({ q: (sql) => (/GROUP|COALESCE\(SUM/.test(sql) ? [{ total_income: '1000.10', total_expense: '400.05' }] : /pflag IN/.test(sql) ? [{ code: 'I1', head_name: 'Interest', pflag: 'I', closing_bal: '1000.10' }] : /code = \$1/.test(sql) ? [{ code: 'L1006', head_name: 'RESERVE FUND' }] : []) });
    expect(await t.svc.getClosingEntriesPreview(5)).toMatchObject({ totalIncome: 1000.1, totalExpense: 400.05, netProfit: 600.05, reserveHead: { code: 'L1006', name: 'RESERVE FUND' } });
  });
  it('preview: reserve head null when missing', async () => {
    expect((await mk({ q: () => [] }).svc.getClosingEntriesPreview(5)).reserveHead).toBeNull();
  });
  it('P&L year end: no active year', async () => { await expect(mk({ current: null }).svc.performPLYearEndProcess('u')).rejects.toThrow(/No active financial year/); });
  it('P&L year end: refuses a closed year', async () => {
    await expect(mk({ current: fy({ closedAt: new Date() }) }).svc.performPLYearEndProcess('u')).rejects.toThrow(/already closed/);
  });
  it('P&L year end: needs the closing transfer first', async () => {
    const t = mk({ current: fy(), q: (sql) => (/COUNT/.test(sql) ? [{ cnt: '0' }] : []) });
    await expect(t.svc.performPLYearEndProcess('u')).rejects.toThrow(/Transfer Entries for Closing/);
  });
  it('P&L year end: refuses to run without the Reserve Fund head and rolls back', async () => {
    const t = mk({ current: fy(), q: (sql) => (/COUNT/.test(sql) ? [{ cnt: '5' }] : /COALESCE\(SUM/.test(sql) ? [{ total_income: '100', total_expense: '40' }] : []) });
    await expect(t.svc.performPLYearEndProcess('u')).rejects.toThrow(/Reserve Fund head/); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
  it('P&L year end: profit goes to the reserve head, income/expense heads reset, new year created with the next code', async () => {
    const t = mk({
      current: fy(),
      q: (sql) => (/COUNT/.test(sql) ? [{ cnt: '5' }] : /COALESCE\(SUM/.test(sql) ? [{ total_income: '100', total_expense: '40' }] : /SELECT code FROM headmaster/.test(sql) ? [{ code: 'L1006' }] : /SELECT yearcode FROM yearend/.test(sql) ? [] : []),
    });
    await t.svc.performPLYearEndProcess('u');
    const profit = t.calls.find((c) => /op_bal, 0\) \+ \$1/.test(c[0]));
    expect(profit![1]).toEqual([60, 'L1006']);
    expect(t.calls.some((c) => /SET op_bal = 0 WHERE pflag IN \('I', 'E'\)/.test(c[0]))).toBe(true);
    const ins = t.calls.find((c) => /INSERT INTO yearend \(/.test(c[0]));
    expect(ins![1][0]).toBe(6); expect(ins![1][1].toISOString().slice(0, 10)).toBe('2027-04-01'); expect(ins![1][2].toISOString().slice(0, 10)).toBe('2028-03-31');
  });
  it('P&L year end marks the year as closed so it cannot be run twice', async () => {
    const t = mk({
      current: fy(),
      q: (sql) => (/COUNT/.test(sql) ? [{ cnt: '5' }] : /COALESCE\(SUM/.test(sql) ? [{ total_income: '100', total_expense: '40' }] : /SELECT code FROM headmaster/.test(sql) ? [{ code: 'L1006' }] : []),
    });
    await t.svc.performPLYearEndProcess('u');
    const closed = t.calls.some((c) => /closed_at|closedAt/i.test(c[0])) || t.repo.update.mock.calls.length > 0;
    expect(closed).toBe(true);
  });
});
