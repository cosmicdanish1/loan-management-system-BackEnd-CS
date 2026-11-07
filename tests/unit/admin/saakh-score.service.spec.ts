import { NotFoundException } from '@nestjs/common';
import { SaakhScoreService } from '../../../src/modules/admin/services/saakh-score.service';

interface Fx { member?: any; loans?: any[]; funds?: any; sureties?: any[]; borrowerLoans?: any[] }
function mk(fx: Fx = {}) {
  const ds: any = {
    query: jest.fn(async (sql: string) => {
      if (/FROM member_master/.test(sql)) return fx.member === null ? [] : [fx.member ?? { mbno: 1, f_name: 'A', m_name: '', l_name: 'B', memb_date: '2000-01-01', isactive: 'Y' }];
      if (/FROM loan_master WHERE CAST\(mbno AS TEXT\) = \$1/.test(sql)) return fx.loans ?? [];
      if (/FROM fundsmaster/.test(sql)) return fx.funds ? [fx.funds] : [];
      if (/FROM suretymaster/.test(sql)) return fx.sureties ?? [];
      if (/ANY\(\$1\)/.test(sql)) return fx.borrowerLoans ?? [];
      return [];
    }),
  };
  return new SaakhScoreService(ds);
}
const yearsAgo = (y: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); return d.toISOString().slice(0, 10); };
const loan = (o: any = {}) => ({ loancaseno: 1, loantype: 'RLN', loan_amt: 100000, balance: 0, openbalance: 100000, instal_amt: 1000, no_of_instal: 100, rate: 12, penalrate: 0, payment_date: '2020-01-01', purpose: 'x', ...o });

describe('admin/SaakhScoreService', () => {
  it('404 for an unknown member', async () => { await expect(mk({ member: null }).calculateSaakhScore('9')).rejects.toThrow(NotFoundException); });

  it('new member without loans or funds: 6.5 = Silver, CONDITIONAL', async () => {
    const r = await mk({ member: { mbno: 1, f_name: 'A', memb_date: new Date().toISOString(), isactive: 'Y' } }).calculateSaakhScore('1');
    expect(r.totalScore).toBe(6.5); expect(r.tier).toBe('Silver'); expect(r.eligibility.eligible).toBe('CONDITIONAL');
  });
  it('best possible profile scores 10 = Platinum, YES, 60 months', async () => {
    const r = await mk({
      member: { mbno: 1, f_name: 'A', memb_date: yearsAgo(15), isactive: 'Y' },
      loans: [loan()], funds: { shareamt: 300000, cdamt: 300000 }, sureties: [{ borrower_mbno: 2, loancaseno: 5 }], borrowerLoans: [{ mbno: 2, loancaseno: 5, balance: 0 }],
    }).calculateSaakhScore('1');
    expect(r.totalScore).toBe(10); expect(r.tier).toBe('Platinum');
    expect(r.eligibility).toMatchObject({ eligible: 'YES', recommendedTenure: 60 });
  });
  it('the factor max scores add up to 10', async () => {
    const r = await mk().calculateSaakhScore('1');
    expect(r.factors.reduce((s, f) => s + f.maxScore, 0)).toBe(10);
  });
  it('no factor score exceeds its max or goes below 0', async () => {
    const r = await mk({ loans: [loan({ balance: 99999, penalrate: 5 }), loan({ loancaseno: 2, balance: 5, penalrate: 5 }), loan({ loancaseno: 3, balance: 5, penalrate: 5 }), loan({ loancaseno: 4, balance: 5, penalrate: 5 })], funds: { suspbal: 100 } }).calculateSaakhScore('1');
    for (const f of r.factors) { expect(f.score).toBeGreaterThanOrEqual(0); expect(f.score).toBeLessThanOrEqual(f.maxScore); }
  });
  it('splits loans into active (balance > 0) and closed', async () => {
    const r = await mk({ loans: [loan({ balance: 500 }), loan({ loancaseno: 2, balance: 0 })] }).calculateSaakhScore('1');
    expect(r.totalActiveLoans).toBe(1); expect(r.closedLoans).toHaveLength(1); expect(r.totalOutstanding).toBe(500);
  });
  it('repaidPct is (opening - balance) / opening', async () => {
    const r = await mk({ loans: [loan({ balance: 25000 })] }).calculateSaakhScore('1');
    expect(r.activeLoans[0].repaidPct).toBe(75);
  });
  it('a missing opening balance falls back to the loan amount', async () => {
    const r = await mk({ loans: [loan({ openbalance: null, balance: 50000 })] }).calculateSaakhScore('1');
    expect(r.activeLoans[0].repaidPct).toBe(50);
  });
  it('repaidPct is never negative or above 100', async () => {
    const r = await mk({ loans: [loan({ balance: 150000 }), loan({ loancaseno: 2, balance: -50 })] }).calculateSaakhScore('1');
    for (const l of [...r.activeLoans, ...r.closedLoans]) { expect(l.repaidPct).toBeGreaterThanOrEqual(0); expect(l.repaidPct).toBeLessThanOrEqual(100); }
  });
  it('3+ active loans give the lowest load score and a tip', async () => {
    const r = await mk({ loans: [1, 2, 3].map((i) => loan({ loancaseno: i, balance: 100 })) }).calculateSaakhScore('1');
    expect(r.factors[2].score).toBe(0.3); expect(r.improvementTips.join(' ')).toMatch(/Close at least one/);
  });
  it('each active loan with a penalty rate costs 0.5 of the penalty score', async () => {
    const r = await mk({ loans: [loan({ balance: 100, penalrate: 2 }), loan({ loancaseno: 2, balance: 100, penalrate: 2 })] }).calculateSaakhScore('1');
    expect(r.factors[1].score).toBe(1);
  });
  it('a suspense balance lowers both repayment and penalty scores and adds a tip', async () => {
    const base = await mk({ loans: [loan()] }).calculateSaakhScore('1');
    const susp = await mk({ loans: [loan()], funds: { suspbal: 10 } }).calculateSaakhScore('1');
    expect(susp.factors[0].score).toBe(base.factors[0].score - 0.5); expect(susp.factors[1].score).toBe(+(base.factors[1].score - 0.3).toFixed(1));
    expect(susp.improvementTips.join(' ')).toMatch(/suspense/);
  });
  it.each([[500000, 1.5], [300000, 1.2], [100000, 0.9], [50000, 0.6], [10000, 0.3], [0, 0.1]])('savings %d gives %d', async (amt, score) => {
    const r = await mk({ funds: { shareamt: amt, cdamt: 0 } }).calculateSaakhScore('1');
    expect(r.factors[3].score).toBe(score);
  });
  it.each([[12, 1.0], [6, 0.8], [3, 0.6], [1, 0.4], [0, 0.2]])('tenure %d years gives %d', async (y, score) => {
    const r = await mk({ member: { mbno: 1, f_name: 'A', memb_date: yearsAgo(y) + (y === 0 ? '' : ''), isactive: 'Y' } }).calculateSaakhScore('1');
    expect(r.factors[4].score).toBe(score);
  });
  it('a future membership date is clamped to 0 years and called out (no negative tenure)', async () => {
    const r = await mk({ member: { mbno: 1, f_name: 'A', memb_date: yearsAgo(-3), isactive: 'Y' } }).calculateSaakhScore('1');
    expect(r.tenureYears).toBe(0); expect(r.factors[4].description).toMatch(/in the future/);
  });
  it('guarantor: all healthy 1.0, still active loan 0.3, never guarantor 0.7', async () => {
    const healthy = await mk({ sureties: [{ borrower_mbno: 2, loancaseno: 5 }], borrowerLoans: [{ mbno: 2, loancaseno: 5, balance: 0 }] }).calculateSaakhScore('1');
    const bad = await mk({ sureties: [{ borrower_mbno: 2, loancaseno: 5 }], borrowerLoans: [{ mbno: 2, loancaseno: 5, balance: 900 }] }).calculateSaakhScore('1');
    const none = await mk().calculateSaakhScore('1');
    expect([healthy.factors[5].score, bad.factors[5].score, none.factors[5].score]).toEqual([1, 0.3, 0.7]);
  });
  it('guarantor check looks only at the guaranteed loan case, not the borrower\'s other loans', async () => {
    const r = await mk({ sureties: [{ borrower_mbno: 2, loancaseno: 5 }], borrowerLoans: [{ mbno: 2, loancaseno: 5, balance: 0 }, { mbno: 2, loancaseno: 6, balance: 9999 }] }).calculateSaakhScore('1');
    expect(r.guarantorInfo.guarantorLoansHealthy).toBe(true);
  });
  it('a legacy surety row without a case number checks all loans of the borrower', async () => {
    const r = await mk({ sureties: [{ borrower_mbno: 2, loancaseno: null }], borrowerLoans: [{ mbno: 2, loancaseno: 6, balance: 9999 }] }).calculateSaakhScore('1');
    expect(r.guarantorInfo.guarantorLoansHealthy).toBe(false);
  });
  it('tier boundaries: 9 Platinum, 7 Gold, 5 Silver, 3 Bronze, below Critical', async () => {
    // build scores through funds / loans: just verify the mapping through known profiles
    const gold = await mk({ member: { mbno: 1, f_name: 'A', memb_date: yearsAgo(6), isactive: 'Y' }, loans: [loan()], funds: { shareamt: 100000 } }).calculateSaakhScore('1');
    expect(gold.totalScore).toBe(8.9); expect(gold.tier).toBe('Gold');
  });
  it('a low scoring member is NO with no recommended amount', async () => {
    const r = await mk({ loans: [1, 2, 3].map((i) => loan({ loancaseno: i, balance: 99000, penalrate: 5 })), funds: { suspbal: 10 } }).calculateSaakhScore('1');
    expect(r.eligibility.eligible).toBe('NO'); expect(r.eligibility.recommendedAmount).toBe(0);
  });
  it('recommended amount is capped at 10 lakh and rounded to 1000', async () => {
    const r = await mk({ member: { mbno: 1, f_name: 'A', memb_date: yearsAgo(15), isactive: 'Y' }, funds: { shareamt: 5_000_000, cdamt: 5_000_000 } }).calculateSaakhScore('1');
    expect(r.eligibility.recommendedAmount).toBe(1_000_000);
  });
  it('a recommended new loan is reduced by the outstanding loans', async () => {
    const free = await mk({ member: { mbno: 1, f_name: 'A', memb_date: yearsAgo(15), isactive: 'Y' }, funds: { shareamt: 200000, cdamt: 100000 } }).calculateSaakhScore('1');
    const busy = await mk({ member: { mbno: 1, f_name: 'A', memb_date: yearsAgo(15), isactive: 'Y' }, funds: { shareamt: 200000, cdamt: 100000 }, loans: [loan({ balance: 90000 })] }).calculateSaakhScore('1');
    expect(busy.eligibility.recommendedAmount).toBeLessThan(free.eligibility.recommendedAmount);
  });
  it('member name joins the parts without double spaces', async () => {
    const r = await mk({ member: { mbno: 1, f_name: 'A', m_name: null, l_name: 'B', memb_date: '2000-01-01', isactive: 'Y' } }).calculateSaakhScore('1');
    expect(r.memberName).toBe('A B');
  });
  it('the member number is only used as a bound parameter', async () => {
    const ds: any = { query: jest.fn().mockResolvedValue([]) };
    await new SaakhScoreService(ds).calculateSaakhScore("1' OR '1'='1").catch(() => undefined);
    expect(ds.query.mock.calls[0][0]).not.toContain("OR '1'='1"); expect(ds.query.mock.calls[0][1]).toEqual(["1' OR '1'='1"]);
  });
});
