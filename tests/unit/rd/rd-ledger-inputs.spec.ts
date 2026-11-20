import { loadRdCdMovements, loadRdCdOpening, localDateFromYmd } from '../../../src/modules/rd/rd-ledger-inputs';

describe('rd/rd-ledger-inputs (ES-581)', () => {
  it('opening = carried-in balance + ledger rows before the year start, rounded to paise', async () => {
    const runner: any = { query: jest.fn().mockResolvedValue([{ opening: 12345.678 }]) };
    expect(await loadRdCdOpening(runner, '5', '2026-04-01')).toBe(12345.68);
    expect(runner.query.mock.calls[0][0]).toMatch(/cdopbal/);
    expect(runner.query.mock.calls[0][1]).toEqual(['5', '2026-04-01']);
  });
  it('a member with no rows has opening 0', async () => {
    expect(await loadRdCdOpening({ query: jest.fn().mockResolvedValue([]) } as any, '5', '2026-04-01')).toBe(0);
  });
  it('credits are deposits, debits are withdrawals, non-positive amounts are ignored', async () => {
    const runner: any = { query: jest.fn().mockResolvedValue([{ d: '2026-04-10', amt: 200, t: 'CR' }, { d: '2026-05-10', amt: 50, t: 'R' }, { d: '2026-06-01', amt: 1000, t: 'DR' }, { d: '2026-06-02', amt: 0, t: 'CR' }]) };
    expect(await loadRdCdMovements(runner, '5', '2026-04-01', '2027-03-31')).toEqual({
      deposits: [{ date: '2026-04-10', amount: 200 }, { date: '2026-05-10', amount: 50 }],
      withdrawals: [{ date: '2026-06-01', amount: 1000 }],
    });
  });
  it('the interest, dividend and insurance journals are excluded in the query', async () => {
    const runner: any = { query: jest.fn().mockResolvedValue([]) };
    await loadRdCdMovements(runner, '5', '2026-04-01', '2027-03-31');
    const sql = runner.query.mock.calls[0][0];
    expect(sql).toMatch(/E1026/); expect(sql).toMatch(/L1024/); expect(sql).toMatch(/L1003/);
  });
  it('localDateFromYmd is a local date, not UTC midnight', () => {
    const d = localDateFromYmd('2027-03-31'); expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2027, 2, 31]);
  });
});
