import { SaakhScoreService } from '../../../src/modules/admin/services/saakh-score.service';

function mk(loans: any[]) {
  const ds: any = {
    query: jest.fn(async (sql: string) => {
      if (/FROM member_master/.test(sql)) return [{ mbno: 1, f_name: 'A', m_name: '', l_name: 'B', memb_date: '2000-01-01', isactive: 'Y' }];
      if (/FROM loan_master WHERE CAST\(mbno AS TEXT\) = \$1/.test(sql)) return loans;
      return [];
    }),
  };
  return new SaakhScoreService(ds);
}
const loan = (o: any = {}) => ({ loancaseno: 1, loantype: 'RLN', loan_amt: 100000, balance: 0, openbalance: 100000, instal_amt: 1000, no_of_instal: 100, rate: 12, penalrate: 0, payment_date: '2020-01-01', purpose: 'x', ...o });
const pct = async (l: any) => {
  const r = await mk([l]).calculateSaakhScore('1');
  return [...r.activeLoans, ...r.closedLoans][0].repaidPct;
};

describe('admin/SaakhScoreService repaid percentage stays between 0 and 100 (ES-404)', () => {
  it('a balance above the opening balance (penalty / interest added) is 0, not negative', async () => {
    expect(await pct(loan({ balance: 150000 }))).toBe(0);
    expect(await pct(loan({ balance: 100001 }))).toBe(0);
  });
  it('a negative balance (overpaid) is 100, not above 100', async () => {
    expect(await pct(loan({ balance: -50 }))).toBe(100);
    expect(await pct(loan({ balance: -1000000 }))).toBe(100);
  });
  it('normal values are unchanged', async () => {
    expect(await pct(loan({ balance: 25000 }))).toBe(75);
    expect(await pct(loan({ balance: 100000 }))).toBe(0);
    expect(await pct(loan({ balance: 0 }))).toBe(100);
    expect(await pct(loan({ balance: 50000 }))).toBe(50);
  });
  it('a loan with no opening balance and no amount counts as fully repaid', async () => {
    expect(await pct(loan({ balance: 0, openbalance: 0, loan_amt: 0 }))).toBe(100);
  });
  it('one overgrown loan no longer drags the average: 100% + a loan with added penalty averages 50, not a negative number', async () => {
    const hi = await mk([loan({ balance: 0 }), loan({ loancaseno: 2, balance: 300000 })]).calculateSaakhScore('1');
    const repayment = hi.factors.find((f) => /repay/i.test(f.name))!;
    expect(repayment.score).toBeGreaterThanOrEqual(0);
    const all = [...hi.activeLoans, ...hi.closedLoans].map((l) => l.repaidPct).sort((a, b) => a - b);
    expect(all).toEqual([0, 100]);
  });
  it('text numbers from the database are handled', async () => {
    expect(await pct(loan({ balance: '40000', openbalance: '100000' }))).toBe(60);
  });
});
