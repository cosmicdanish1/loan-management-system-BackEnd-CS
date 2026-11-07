import { BadRequestException } from '@nestjs/common';
import { InterestService } from '../../../src/modules/interest/interest.service';

function mk(calc?: (m: any) => any) {
  const calls: string[] = [];
  const manager: any = { query: jest.fn(async (sql: string) => { calls.push(sql); return /FROM ledger WHERE receipt_vchr_no/.test(sql) ? [{ trans_type: 'DR', total: '100' }, { trans_type: 'CR', total: '100' }] : []; }), save: jest.fn(async (_e: any, x: any) => x), find: jest.fn().mockResolvedValue([]) };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), manager };
  const ds: any = { createQueryRunner: () => qr, query: jest.fn().mockResolvedValue([]) };
  const master: any = { findOne: jest.fn().mockResolvedValue(null) };
  const svc: any = new InterestService(master, {} as any, {} as any, {} as any, {} as any, {} as any, ds);
  svc.getEligibleMembers = jest.fn().mockResolvedValue([{ mbno: '1', fullName: 'A' }, { mbno: '2', fullName: 'B' }]);
  svc.getNextId = jest.fn().mockResolvedValue(1);
  svc.createInterestLedgerEntry = jest.fn().mockResolvedValue(undefined);
  svc.calculateMemberInterest = jest.fn(async (m: any) => calc ? calc(m) : { memberNumber: m.mbno, accountNumber: m.mbno, openingBalance: 1, totalDebit: 0, totalCredit: 0, averageBalance: 1, interestAmount: 5, closingBalance: 6 });
  jest.spyOn(svc.logger, 'log').mockImplementation(() => undefined); jest.spyOn(svc.logger, 'error').mockImplementation(() => undefined);
  return { svc: svc as InterestService, qr, calls, master, any: svc };
}
const dto = (o: any = {}) => ({ fromDate: '2026-04-01', toDate: '2026-06-30', interestRate: 4, voucherNumber: 'J00001', accountType: 'SB', ...o }) as any;

describe('interest run checks (ES-408)', () => {
  it('run and validate give the same answer for dates, period and rate', async () => {
    const bad = [dto({ fromDate: 'garbage' }), dto({ toDate: '2026-02-30x' }), dto({ fromDate: '2025-01-01' }), dto({ interestRate: -1 }), dto({ interestRate: 51 }), dto({ interestRate: 'abc' }), dto({ interestRate: '' }), dto({ interestRate: NaN }), dto({ interestRate: undefined })];
    for (const d of bad) {
      const t = mk();
      expect((await t.svc.validateInterestParameters(d)).valid).toBe(false);
      await expect(t.svc.updateSavingInterest(d)).rejects.toBeInstanceOf(BadRequestException);
      expect(t.qr.rollbackTransaction).toHaveBeenCalled();
      expect(t.qr.commitTransaction).not.toHaveBeenCalled();
    }
  });
  it('edges are accepted: rate 0 and 50, exactly 365 days, rate sent as text', async () => {
    for (const d of [dto({ interestRate: 0 }), dto({ interestRate: 50 }), dto({ fromDate: '2026-01-01', toDate: '2027-01-01' }), dto({ interestRate: '4.5' })]) expect((await mk().svc.validateInterestParameters(d)).valid).toBe(true);
  });
  it('a failing member stops the run, names the member, rolls back and commits nothing', async () => {
    const t = mk((m) => { if (m.mbno === '2') throw new Error('bad data'); return { memberNumber: '1', accountNumber: '1', openingBalance: 1, totalDebit: 0, totalCredit: 0, averageBalance: 1, interestAmount: 5, closingBalance: 6 }; });
    await expect(t.svc.updateSavingInterest(dto())).rejects.toThrow('Interest calculation failed for member 2: bad data');
    expect(t.qr.rollbackTransaction).toHaveBeenCalledTimes(1); expect(t.qr.commitTransaction).not.toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalledTimes(1);
  });
  it('the lock is per account type and is taken before the overlap check and before anything is written', async () => {
    for (const type of ['SB', 'RD']) {
      const t = mk(); await t.svc.updateSavingInterest(dto({ accountType: type }));
      const lock = t.calls.findIndex((c) => /pg_advisory_xact_lock/.test(c)); const overlap = t.calls.findIndex((c) => /FROM interestmaster/.test(c));
      expect(lock).toBeGreaterThan(-1); expect(lock).toBeLessThan(overlap);
    }
  });
  it('a negative balance gives 0 interest, never a negative amount; a positive one is unchanged', async () => {
    const run = (opening: number) => { const t = mk(); t.any.getOpeningBalance = jest.fn().mockResolvedValue(opening); return (InterestService.prototype as any).calculateMemberInterest.call(t.any, { mbno: '1', fullName: 'A' }, new Date(2026, 3, 1), new Date(2026, 3, 10), 10, { find: jest.fn().mockResolvedValue([]) }, 'SB'); };
    expect((await run(-36500)).interestAmount).toBe(0);
    expect((await run(36500)).interestAmount).toBe(100);
  });
});

describe('interest credit heads (ES-121)', () => {
  it('SB credits A001, RD credits L1004, never CASH IN HAND (A1001) or REGULAR LOAN (A1002); an explicit head wins', async () => {
    for (const [type, head] of [['SB', 'A001'], ['RD', 'L1004']]) {
      const t = mk(); await t.svc.updateSavingInterest(dto({ accountType: type }));
      expect(t.any.createInterestLedgerEntry.mock.calls[0][5]).toBe(head);
      expect(['A1001', 'A1002']).not.toContain(t.any.createInterestLedgerEntry.mock.calls[0][5]);
    }
    const t = mk(); await t.svc.updateSavingInterest(dto({ accountHead: 'X9' })); expect(t.any.createInterestLedgerEntry.mock.calls[0][5]).toBe('X9');
  });
});
