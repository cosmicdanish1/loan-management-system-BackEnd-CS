import { BadRequestException } from '@nestjs/common';
import { InterestService } from '../../../src/modules/interest/interest.service';

function mk(o: { overlap?: any[]; members?: any[]; calc?: (m: any) => any; ledgerRows?: any[] } = {}) {
  const calls: any[] = [];
  const manager: any = {
    query: jest.fn(async (sql: string, p?: any[]) => {
      calls.push([sql, p]);
      if (/FROM interestmaster/.test(sql)) return o.overlap ?? [];
      if (/FROM ledger WHERE receipt_vchr_no/.test(sql)) return o.ledgerRows ?? [{ trans_type: 'DR', total: '100' }, { trans_type: 'CR', total: '100' }];
      return [];
    }),
    save: jest.fn(async (_e: any, x: any) => x), find: jest.fn().mockResolvedValue([]),
  };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), manager };
  const ds: any = { createQueryRunner: jest.fn(() => qr), query: jest.fn().mockResolvedValue([]) };
  const master: any = { findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]) };
  const svc: any = new InterestService(master, {} as any, {} as any, {} as any, {} as any, {} as any, ds);
  const members = o.members ?? [{ mbno: '1', fullName: 'A' }, { mbno: '2', fullName: 'B' }];
  svc.getEligibleMembers = jest.fn().mockResolvedValue(members);
  svc.getNextId = jest.fn().mockResolvedValue(1);
  svc.createInterestLedgerEntry = jest.fn().mockResolvedValue(undefined);
  svc.calculateMemberInterest = jest.fn(async (m: any) => (o.calc ? o.calc(m) : { memberNumber: m.mbno, memberName: m.fullName, accountNumber: m.mbno, openingBalance: 1000, totalDebit: 0, totalCredit: 0, averageBalance: 1000, interestAmount: 50, closingBalance: 1050, days: 30 }));
  jest.spyOn(svc.logger, 'log').mockImplementation(() => undefined); jest.spyOn(svc.logger, 'error').mockImplementation(() => undefined);
  return { svc: svc as InterestService, qr, manager, calls, master, anySvc: svc };
}
const dto = (o: any = {}) => ({ fromDate: '2026-04-01', toDate: '2026-06-30', interestRate: 4, voucherNumber: 'J00001', accountType: 'SB', ...o }) as any;

describe('interest/InterestService.updateSavingInterest', () => {
  it('rejects from date on or after to date and rolls back', async () => {
    const t = mk(); await expect(t.svc.updateSavingInterest(dto({ fromDate: '2026-06-30', toDate: '2026-04-01' }))).rejects.toThrow(/before to date/);
    expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('rejects invalid dates', async () => { await expect(mk().svc.updateSavingInterest(dto({ fromDate: 'garbage' }))).rejects.toThrow(BadRequestException); });
  it('rejects a negative, absurd or non numeric interest rate', async () => {
    for (const interestRate of [-4, 500, 'abc', NaN]) await expect(mk().svc.updateSavingInterest(dto({ interestRate }))).rejects.toThrow(BadRequestException);
  });
  it('rejects a period that overlaps an earlier run of the same type', async () => {
    await expect(mk({ overlap: [{ id: 1 }] }).svc.updateSavingInterest(dto())).rejects.toThrow(/already been calculated/);
  });
  it('the period is not longer than one year (same rule as the validate call)', async () => {
    await expect(mk().svc.updateSavingInterest(dto({ fromDate: '2020-01-01', toDate: '2026-06-30' }))).rejects.toThrow(BadRequestException);
  });
  it('credits every member with interest, one summary, one commit', async () => {
    const t = mk(); const r = await t.svc.updateSavingInterest(dto());
    expect(r).toMatchObject({ totalMembers: 2, totalInterestAmount: 100, voucherNumber: 'J00001', interestRate: 4 }); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
    expect(t.anySvc.createInterestLedgerEntry).toHaveBeenCalledTimes(2);
  });
  it('a single member filter restricts the run to that member', async () => {
    const t = mk(); const r = await t.svc.updateSavingInterest(dto({ memberNo: '2' })); expect(r.totalMembers).toBe(1);
  });
  it('members who earn nothing are skipped; if nobody earns anything the run is refused and the period stays open', async () => {
    const t = mk({ calc: (m) => ({ memberNumber: m.mbno, interestAmount: 0, openingBalance: 0, totalDebit: 0, totalCredit: 0, averageBalance: 0, closingBalance: 0 }) });
    await expect(t.svc.updateSavingInterest(dto())).rejects.toThrow(/nothing was posted/); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
  it('an unbalanced voucher stops the run (double entry check) and rolls back', async () => {
    const t = mk({ ledgerRows: [{ trans_type: 'DR', total: '100' }, { trans_type: 'CR', total: '99' }] });
    await expect(t.svc.updateSavingInterest(dto())).rejects.toThrow(/Double-entry validation failed/); expect(t.qr.commitTransaction).not.toHaveBeenCalled();
  });
  it('a member whose calculation fails stops the whole run instead of being silently left without interest', async () => {
    const t = mk({ calc: (m) => { if (m.mbno === '2') throw new Error('bad data'); return { memberNumber: m.mbno, accountNumber: m.mbno, openingBalance: 1, totalDebit: 0, totalCredit: 0, averageBalance: 1, interestAmount: 5, closingBalance: 6 }; } });
    await expect(t.svc.updateSavingInterest(dto())).rejects.toThrow(/bad data/);
  });
  it('uses the account-type GL heads: SB A001, RD L1004, FD A1003 (on hold) unless a head is given', async () => {
    const t = mk(); await t.svc.updateSavingInterest(dto());
    expect(t.anySvc.createInterestLedgerEntry.mock.calls[0][5]).toBe('A001');
    const r = mk(); await r.svc.updateSavingInterest(dto({ accountType: 'RD' })); expect(r.anySvc.createInterestLedgerEntry.mock.calls[0][5]).toBe('L1004');
    const g = mk(); await g.svc.updateSavingInterest(dto({ accountHead: 'X9' })); expect(g.anySvc.createInterestLedgerEntry.mock.calls[0][5]).toBe('X9');
  });
  it('interest on Saving and RD accounts is not credited to the cash-in-hand / regular-loan heads (A1001 is CASH IN HAND, A1002 is REGULAR LOAN)', async () => {
    const t = mk(); await t.svc.updateSavingInterest(dto());
    expect(['A1001', 'A1002']).not.toContain(t.anySvc.createInterestLedgerEntry.mock.calls[0][5]);
  });
  it('two runs at the same moment cannot both pass the overlap check (advisory lock before the check)', async () => {
    const t = mk(); await t.svc.updateSavingInterest(dto());
    const lock = t.calls.findIndex((c) => /pg_advisory_xact_lock/.test(c[0])); const check = t.calls.findIndex((c) => /FROM interestmaster/.test(c[0]));
    expect(lock).toBeGreaterThan(-1); expect(lock).toBeLessThan(check);
  });
  it('a generated voucher number is requested when none is given', async () => {
    const t = mk(); await t.svc.updateSavingInterest(dto({ voucherNumber: undefined })).catch(() => undefined);
    expect(t.calls.some((c) => /voucher_master/.test(c[0]))).toBe(true);
  });
});

describe('interest/InterestService.validateInterestParameters', () => {
  it('rejects from >= to, a period over 365 days, rates outside 0-50 and an existing run', async () => {
    const t = mk();
    expect((await t.svc.validateInterestParameters(dto({ fromDate: '2026-06-30', toDate: '2026-04-01' }))).message).toMatch(/before to date/);
    expect((await t.svc.validateInterestParameters(dto({ fromDate: '2025-01-01', toDate: '2026-06-30' }))).message).toMatch(/365 days/);
    expect((await t.svc.validateInterestParameters(dto({ interestRate: 51 }))).message).toMatch(/between 0% and 50%/);
    expect((await t.svc.validateInterestParameters(dto({ interestRate: -1 }))).valid).toBe(false);
    t.master.findOne.mockResolvedValue({ id: 1 }); expect((await t.svc.validateInterestParameters(dto())).message).toMatch(/already been calculated/);
  });
  it('valid parameters return the eligible member count', async () => {
    expect(await mk().svc.validateInterestParameters(dto())).toEqual({ valid: true, message: 'Parameters are valid', eligibleMembers: 2 });
  });
  it('invalid or missing dates and a non numeric rate are not valid', async () => {
    const t = mk();
    expect((await t.svc.validateInterestParameters(dto({ fromDate: 'garbage' }))).valid).toBe(false);
    expect((await t.svc.validateInterestParameters(dto({ interestRate: 'abc' }))).valid).toBe(false);
    expect((await t.svc.validateInterestParameters(dto({ interestRate: NaN }))).valid).toBe(false);
  });
});

describe('interest/InterestService private calculations', () => {
  const svc: any = mk().anySvc;
  const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
  describe('FD legacy formula (years, months of 30 days, days)', () => {
    it('one year is the annual rate', () => expect(svc.calculateFDInterest(10000, 8, d(2025, 1, 1), d(2026, 1, 1))).toBe(800));
    it('30 days is one month: P x R / 1200', () => expect(svc.calculateFDInterest(10000, 12, d(2026, 1, 1), d(2026, 1, 31))).toBe(100));
    it('10 days: P x R x 10 / 36500', () => expect(svc.calculateFDInterest(36500, 10, d(2026, 1, 1), d(2026, 1, 11))).toBe(100));
    it('years + months + days add up', () => {
      const exp = Math.round((10000 * 10 * 1 / 100 + 10000 * 10 * 2 / 1200 + 10000 * 10 * 5 / 36500) * 100) / 100;
      expect(svc.calculateFDInterest(10000, 10, d(2025, 1, 1), new Date(d(2025, 1, 1).getTime() + (365 + 65) * 86400000))).toBe(exp);
    });
    it('no interest when the calculation date is not after the deposit date', () => { expect(svc.calculateFDInterest(10000, 8, d(2026, 1, 1), d(2026, 1, 1))).toBe(0); expect(svc.calculateFDInterest(10000, 8, d(2026, 2, 1), d(2026, 1, 1))).toBe(0); });
    it('a leap year is 365 days of interest like any other (a deposit of 366 days is one year and one day)', () => {
      const v = svc.calculateFDInterest(36500, 10, d(2024, 1, 1), d(2025, 1, 1)); expect(v).toBe(3650 + 10);
    });
  });
  describe('daily balances', () => {
    const tx = (day: number, type: 'CR' | 'DR', amt: number) => ({ transactionDate: d(2026, 4, day), transactionType: type, transactionAmount: amt });
    it('one balance per day, inclusive of both dates', () => { expect(svc.calculateDailyBalances([], d(2026, 4, 1), d(2026, 4, 30), 100)).toHaveLength(30); });
    it('a credit counts from the day it is made', () => {
      const r = svc.calculateDailyBalances([tx(3, 'CR', 50)], d(2026, 4, 1), d(2026, 4, 5), 100); expect(r.map((x: any) => x.balance)).toEqual([100, 100, 150, 150, 150]);
    });
    it('a debit lowers the balance from that day', () => {
      const r = svc.calculateDailyBalances([tx(2, 'DR', 30)], d(2026, 4, 1), d(2026, 4, 3), 100); expect(r.map((x: any) => x.balance)).toEqual([100, 70, 70]);
    });
    it('several transactions on one day are all applied', () => {
      const r = svc.calculateDailyBalances([tx(2, 'CR', 50), tx(2, 'DR', 20)], d(2026, 4, 1), d(2026, 4, 2), 0); expect(r[1].balance).toBe(30);
    });
    it('a transaction before the period start does not break the walk', () => {
      const r = svc.calculateDailyBalances([{ transactionDate: d(2026, 3, 20), transactionType: 'CR', transactionAmount: 999 }, tx(2, 'CR', 10)], d(2026, 4, 1), d(2026, 4, 2), 0); expect(r[1].balance).toBe(10);
    });
    it('amounts coming from the database as text are added as numbers', () => {
      const r = svc.calculateDailyBalances([tx(1, 'CR', '25.50' as any)], d(2026, 4, 1), d(2026, 4, 1), 0.1); expect(r[0].balance).toBeCloseTo(25.6, 5);
    });
  });
  describe('SB interest (daily product method)', () => {
    const run = (opening: number, txs: any[], from: Date, to: Date, rate: number) => {
      const manager = { find: jest.fn().mockResolvedValue(txs) }; svc.getOpeningBalance = jest.fn().mockResolvedValue(opening);
      return (InterestService.prototype as any).calculateMemberInterest.call(svc, { mbno: '1', fullName: 'A' }, from, to, rate, manager, 'SB');
    };
    it('a flat balance of 36500 for 10 days at 10% earns 100', async () => {
      const r = await run(36500, [], d(2026, 4, 1), d(2026, 4, 10), 10); expect(r).toMatchObject({ interestAmount: 100, days: 10, averageBalance: 36500, closingBalance: 36600 });
    });
    it('closing = opening + credits - debits + interest and totals are summed', async () => {
      const r = await run(1000, [{ transactionDate: d(2026, 4, 2), transactionType: 'CR', transactionAmount: '500' }, { transactionDate: d(2026, 4, 3), transactionType: 'DR', transactionAmount: '200' }], d(2026, 4, 1), d(2026, 4, 3), 0);
      expect(r).toMatchObject({ totalCredit: 500, totalDebit: 200, closingBalance: 1300, interestAmount: 0 });
    });
    it('interest is rounded to paise', async () => { const r = await run(1000, [], d(2026, 4, 1), d(2026, 4, 7), 4.3); expect(r.interestAmount).toBe(Math.round(r.interestAmount * 100) / 100); });
    it('a negative balance never produces negative interest', async () => { const r = await run(-5000, [], d(2026, 4, 1), d(2026, 4, 30), 4); expect(r.interestAmount).toBeGreaterThanOrEqual(0); });
  });
});

describe('interest/InterestService.previewInterestCalculation (ES-510)', () => {
  it('SB preview calculates only the members who hold an SB ledger account up to the period end', async () => {
    const t = mk();
    (t.anySvc.dataSource ?? (t.anySvc as any).dataSource).query = jest.fn().mockResolvedValue([{ mbno: '2' }]);
    const r = await t.svc.previewInterestCalculation(dto());
    expect(t.anySvc.calculateMemberInterest).toHaveBeenCalledTimes(1);
    expect(t.anySvc.calculateMemberInterest.mock.calls[0][0].mbno).toBe('2');
    expect(r.totalMembers).toBe(1);
  });
  it('FD preview keeps every eligible member (it reads its own tables)', async () => {
    const t = mk();
    const r = await t.svc.previewInterestCalculation(dto({ accountType: 'FD' }));
    expect(t.anySvc.calculateMemberInterest).toHaveBeenCalledTimes(2);
    expect(r.totalMembers).toBe(2);
  });
});
