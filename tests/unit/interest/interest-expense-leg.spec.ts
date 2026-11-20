// ES-457: the interest expense leg is head-only and both legs are dated at the period end; the savings-interest head
// is found by name and created when it is not there.
import { InterestService } from '../../../src/modules/interest/interest.service';

function mk() {
  const saved: any[] = [];
  const ds: any = { query: jest.fn().mockResolvedValue([]) };
  const svc: any = new InterestService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, ds);
  svc.generateTransactionNumber = jest.fn().mockResolvedValue(1);
  svc.getNextId = jest.fn().mockResolvedValue(1);
  const manager: any = { save: jest.fn(async (_e: any, x: any) => { saved.push(x); return x; }), query: jest.fn() };
  return { svc, manager, saved };
}
const member: any = { mbno: '900000002' };
const calc: any = { accountNumber: '900000002', interestAmount: 2.86, closingBalance: 6536.33 };

describe('interest ledger legs (ES-457)', () => {
  it('the expense leg is head-only (member 0, type OTH) and does not carry the member or the SB type', async () => {
    const t = mk();
    await t.svc.createInterestLedgerEntry(member, calc, 'J1', 'run', t.manager, 'A001', 'SB', 'E1033', new Date('2026-11-18'));
    const [credit, debit] = t.saved;
    expect(credit).toMatchObject({ transactionType: 'CR', code: 'A001', memberNumber: '900000002', accountType: 'SB' });
    expect(debit).toMatchObject({ transactionType: 'DR', code: 'E1033', memberNumber: 0, accountNumber: 0, accountType: 'OTH' });
  });

  it('both legs carry the period end date, not the run time', async () => {
    const t = mk();
    const periodEnd = new Date('2026-11-18');
    await t.svc.createInterestLedgerEntry(member, calc, 'J1', 'run', t.manager, 'A001', 'SB', 'E1033', periodEnd);
    expect(t.saved[0].transactionDate).toBe(periodEnd);
    expect(t.saved[1].transactionDate).toBe(periodEnd);
  });

  it('finds the savings-interest head by name and does not create a second one', async () => {
    const t = mk();
    t.manager.query.mockResolvedValueOnce([{ code: 'E1033' }]);
    await expect(t.svc.ensureSavingsInterestExpenseHead(t.manager)).resolves.toBe('E1033');
    expect(t.manager.query).toHaveBeenCalledTimes(1);
  });

  it('creates the head as an expense head under E1000 with the next free E code when it is missing', async () => {
    const t = mk();
    t.manager.query
      .mockResolvedValueOnce([])                 // not found by name
      .mockResolvedValueOnce([])                 // lock
      .mockResolvedValueOnce([])                 // not created meanwhile by another run
      .mockResolvedValueOnce([{ n: 1033 }])      // next free code
      .mockResolvedValueOnce([]);                // insert
    await expect(t.svc.ensureSavingsInterestExpenseHead(t.manager)).resolves.toBe('E1033');
    const insert = t.manager.query.mock.calls.find((c: any[]) => /INSERT INTO headmaster/.test(c[0]));
    expect(insert[1]).toEqual(['E1033', 'INTEREST PAID ON SAVINGS DEPOSIT']);
    expect(insert[0]).toMatch(/'E1000'.*'E'\)/s);
  });
});
