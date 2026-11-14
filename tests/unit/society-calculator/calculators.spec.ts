import { computeClosure } from '../../../src/modules/society-calculator/engine/closure.engine';
import { computePenalty } from '../../../src/modules/society-calculator/engine/penalty.engine';
import { computeFd, computeRd, computeSb } from '../../../src/modules/society-calculator/engine/deposit.engine';
import {
  computeConsolidation, computeDividend, computeEligibility, computeInsurance, computeLoanAgainstRd, computeReagreement, computeSaakh,
} from '../../../src/modules/society-calculator/engine/member.engine';
import { defaultRules } from '../../../src/modules/society-calculator/engine/rules';

const rules = { ...defaultRules('2026-11-14'), penaltyEnabled: true };
const kpi = (r: any, label: string) => r.kpis.find((k: any) => k.label === label)?.value;

describe('society-calculator / early closure (SOP 11.5)', () => {
  it('300,000 / 12 % / 40 closed 10-Dec-2026 with November unpaid: closure 290,100', () => {
    const r = computeClosure({
      loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15', outstandingPrincipal: 277500,
      closureDate: '2026-12-10', nrFromDate: '2026-11-01', graceDay: 15, penalRate: 15,
    }, rules);
    expect(r.emi.installment).toBe(9188);
    expect(r.paidInstallments).toBe(3);
    expect(r.startedInstallments).toBe(4);
    expect(r.futureInstallments).toBe(36);
    expect(r.graceInstallment).toBe('2026-12'); // December is still inside its grace period
    expect(r.nrPrincipal).toBe(7500);
    expect(r.nrInterest).toBe(1688);
    expect(r.apInterest).toBe(10818);
    expect(r.closureInterest).toBe(12506);
    expect(r.penalInterest).toBe(94);
    expect(r.finalClosureAmount).toBe(290100);
  });

  it('Gemini clean baseline: 300,000 / monthly principal 3,750 / slot 2 / outstanding 225,000 -> 252,015', () => {
    const r = computeClosure({
      loanAmount: 300000, annualRate: 12, monthlyPrincipal: 3750, applicationDate: '2026-06-15', outstandingPrincipal: 225000, closureDate: '2026-11-13',
    }, rules);
    expect(r.emi.installment).toBe(5344);
    expect(r.futureInstallments).toBe(60);
    expect(r.closureInterest).toBe(27015);
    expect(r.finalClosureAmount).toBe(252015);
    expect(r.interestSaved).toBe(68625);
  });

  it('the slot can be typed as 1 or 2 instead of an application date: Slot 2 = EMI 5,344, Slot 1 = 5,094 on the Gemini loan', () => {
    const at = (slot: number) => computeClosure({ loanAmount: 300000, annualRate: 12, monthlyPrincipal: 3750, slot, outstandingPrincipal: 225000, closureDate: '2026-11-13' }, rules);
    expect(at(2).emi.installment).toBe(5344);
    expect(at(2).finalClosureAmount).toBe(252015);
    expect(at(1).emi.installment).toBeLessThan(5344);
    expect(() => at(3)).toThrow(/Slot/);
  });

  it('no same-month fee in a closure quote: a closure after the grace day charges flat interest but no Tier 1', () => {
    const r = computeClosure({
      loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15', outstandingPrincipal: 277500,
      closureDate: '2026-11-20', nrFromDate: '2026-11-01', graceDay: 15, penalRate: 15,
    }, rules);
    expect(r.graceInstallment).toBeNull();
    expect(r.register).toHaveLength(1);
    expect(r.register[0]).toMatchObject({ unpaidPrincipal: 7500, interestDue: 1688, tier: 0, penalty: 0 });
  });

  it('RD / Share adjustment keeps the minimum in each and uses RD first (SOP 11.6)', () => {
    const r = computeClosure({
      loanAmount: 300000, annualRate: 12, monthlyPrincipal: 3750, applicationDate: '2026-06-15', outstandingPrincipal: 225000, closureDate: '2026-11-13',
      rdBalance: 40000, shareBalance: 5000,
    }, rules);
    expect(r.rdShare).toMatchObject({ rdAvailable: 39000, shareAvailable: 4000, appliedFromRdShare: 43000, fromRd: 39000, fromShare: 4000 });
    expect(r.rdShare.payableByMember).toBe(252015 - 43000);
  });

  it('refuses nonsense with a clear message', () => {
    const bad = (o: any) => () => computeClosure({ loanAmount: 100000, annualRate: 12, installments: 12, applicationDate: '2026-06-15', outstandingPrincipal: 50000, closureDate: '2026-11-13', ...o }, rules);
    expect(bad({ outstandingPrincipal: 200000 })).toThrow(/cannot be more than the loan amount/);
    expect(bad({ installments: undefined })).toThrow(/monthly principal or the number of installments/);
    expect(bad({ closureDate: 'soon' })).toThrow(/YYYY-MM-DD/);
    expect(bad({ nrOverrides: 'x' })).toThrow(/must be a list/);
  });
});

describe('society-calculator / penalty (SOP 10.5)', () => {
  const run = (asOfDate: string, source = 'CASH') => computePenalty({ principalDue: 7500, dueMonthDate: '2026-08-01', asOfDate, graceDay: 15, penalRate: 15, smPct: 1, smDiv: 4, source }, rules);
  it('grace / tier 1 / tier 2 values', () => {
    expect(kpi(run('2026-08-10'), 'Penalty due')).toBe(0);
    expect(kpi(run('2026-08-20'), 'Penalty due')).toBe(18.75);
    expect(kpi(run('2026-08-20', 'DEMAND'), 'Penalty due')).toBe(0);
    expect(kpi(run('2026-09-03'), 'Penalty due')).toBe(93.75);
    expect(kpi(run('2026-10-03'), 'Penalty due')).toBe(187.5);
  });
});

describe('society-calculator / deposit interest (SOP 15, 16, 18)', () => {
  it('SB daily product: 50,000, +20,000 on 11-Apr, -5,000 on 21-Apr, 4 %, 30 days = 202.74', () => {
    const r = computeSb({
      openingBalance: 50000, annualRate: 4, fromDate: '2026-04-01', toDate: '2026-04-30',
      transactions: [{ date: '2026-04-11', type: 'CR', amount: 20000 }, { date: '2026-04-21', type: 'DR', amount: 5000 }],
    });
    expect(kpi(r, 'Sum of daily balances')).toBe(1850000);
    expect(kpi(r, 'Interest')).toBe(202.74);
  });
  it('an overdrawn SB account never earns negative interest', () => {
    expect(kpi(computeSb({ openingBalance: -1000, annualRate: 4, fromDate: '2026-04-01', toDate: '2026-04-30' }), 'Interest')).toBe(0);
  });
  it('FD legacy: 100,000 at 8 % for 400 days = 8,776.26', () => {
    const r = computeFd({ principal: 100000, annualRate: 8, depositDate: '2025-01-01', calcDate: '2026-02-05' });
    expect(kpi(r, 'Total days')).toBe(400);
    expect(kpi(r, 'Interest')).toBe(8776.26);
  });
  it('RD: 1,000 a month at 7 %, every installment on time = 455.00 (SOP 18.2)', () => {
    const r = computeRd({ monthlyAmount: 1000, fyStartDate: '2026-04-01' }, rules);
    expect(kpi(r, 'Installment interest')).toBe(455);
    expect(kpi(r, 'Total interest credited')).toBe(455);
  });
  it('RD late installment: eligible keeps 9 months, not eligible gets 6 (SOP 18.2)', () => {
    const rows = [{ dueMonth: '2026-07', status: 'LATE', paidDate: '2026-10-05' }];
    const yes = computeRd({ monthlyAmount: 1000, fyStartDate: '2026-04-01', installments: rows, fullInterestEligible: 'YES' }, rules);
    const no = computeRd({ monthlyAmount: 1000, fyStartDate: '2026-04-01', installments: rows, fullInterestEligible: 'NO' }, rules);
    expect(kpi(yes, 'Installment interest')).toBe(52.5);
    expect(kpi(no, 'Installment interest')).toBe(35);
  });
  it('RD opening balance with a withdrawal: 20,000 then 15,000 from Sep = 1,195.83 (5 + 7 months, SOP 18.3)', () => {
    const r = computeRd({
      monthlyAmount: 1000, fyStartDate: '2026-04-01', installments: [{ dueMonth: '2026-04', status: 'UNPAID' }],
      balanceEvents: [{ date: '2026-04-01', type: 'OPENING', balance: 20000 }, { date: '2026-09-12', type: 'WITHDRAWAL', balance: 15000 }],
    }, rules);
    expect(kpi(r, 'Opening-balance interest')).toBe(1195.83);
  });
});

describe('society-calculator / member money (SOP 3, 7, 12, 18.6, 20, 21, 29)', () => {
  it('RD / Share shortfall: exposure 500,000, RD 10,000, Share 30,000 -> net payout 285,000 (SOP 3.5)', () => {
    const r = computeEligibility({ loanType: 'RLN', loanAmount: 300000, existingOutstanding: 200000, currentRd: 10000, currentShare: 30000 }, rules);
    expect(kpi(r, 'RD shortfall')).toBe(15000);
    expect(kpi(r, 'Share shortfall')).toBe(0);
    expect(kpi(r, 'Net payout')).toBe(285000);
  });
  it('Loan Against RD: total 100,000, locked 20,000 -> 70,000 (SOP 18.6)', () => {
    expect(kpi(computeLoanAgainstRd({ totalRd: 100000, lockedRd: 20000 }, rules), 'Maximum Loan Against RD')).toBe(70000);
  });
  it('consolidation: 100,000 + 200,000 -> combined 300,000, net payout 196,500 when RD and Share are enough', () => {
    const r = computeConsolidation({
      loanType: 'RLN', existingBalance: 100000, sanctionedAmount: 200000, annualRate: 12, installments: 40, applicationDate: '2026-06-15',
      oldClosureInterest: 3500, currentRd: 25000, currentShare: 25000,
    }, rules);
    expect(kpi(r, 'Combined principal')).toBe(300000);
    expect(kpi(r, 'New monthly EMI')).toBe(9188);
    expect(kpi(r, 'Net payout to member')).toBe(196500); // exposure 300,000 -> 15,000 required each; RD and Share already enough
    // RD short by 5,000 -> withheld too: 200,000 - 3,500 - 5,000 = 191,500 (SOP 7.4)
    const short = computeConsolidation({ loanType: 'RLN', existingBalance: 100000, sanctionedAmount: 200000, annualRate: 12, installments: 40, applicationDate: '2026-06-15', oldClosureInterest: 3500, currentRd: 10000, currentShare: 15000 }, rules);
    expect(kpi(short, 'Net payout to member')).toBe(191500);
  });
  it('consolidation is blocked when the withholding is more than the new cash', () => {
    const r = computeConsolidation({ loanType: 'RLN', existingBalance: 100000, sanctionedAmount: 1000, annualRate: 12, installments: 40, applicationDate: '2026-06-15', oldClosureInterest: 3500, currentRd: 99999, currentShare: 99999 }, rules);
    expect(kpi(r, 'Blocked: withholding is more than the new cash')).toBe('Blocked');
  });
  it('re-agreement: 277,500, carried 7,000, 30 months at 12 % applied 15-Dec-2026', () => {
    const r = computeReagreement({ outstandingPrincipal: 277500, apInterest: 7000, nrInterest: 1688, penalty: 94, annualRate: 12, installments: 30, applicationDate: '2026-12-15' }, rules);
    expect(kpi(r, 'Collect now (NR + penalty)')).toBe(1782);
    expect(kpi(r, 'Interest carried')).toBe(7000);
  });
  it('dividend: 6 x 10,000 + 6 x 12,000 at 10 % = 1,100 (SOP 20.2)', () => {
    const balances = [...Array(6).fill(10000), ...Array(6).fill(12000)].map((balance, i) => ({ month: `M${i + 1}`, balance }));
    expect(kpi(computeDividend({ dividendRate: 10, balances }), 'Dividend')).toBe(1100);
  });
  it('group insurance: 120,000 / 500 members; joined July = 180, joined January = 60, fractional share rounds up (SOP 21)', () => {
    const at = (o: any) => kpi(computeInsurance({ lumpSum: 120000, activeMembers: 500, fyStartDate: '2026-04-01', ...o }), 'Charge for this member');
    expect(at({})).toBe(240);
    expect(at({ joinDate: '2026-07-10' })).toBe(180);
    expect(at({ joinDate: '2027-01-02' })).toBe(60);
    expect(kpi(computeInsurance({ lumpSum: 70000, activeMembers: 300, fyStartDate: '2026-04-01' }), 'Charge for this member')).toBe(234);
  });
  it('Saakh score example (SOP 29.3): 7.9 Gold, recommended 419,000', () => {
    const r = computeSaakh({ hasLoanHistory: 'YES', avgRepaidPct: 87.5, loansWithPenalty: 1, activeLoans: 1, shareCapital: 80000, cdBalance: 70000, tenureYears: 6, guarantorFor: 1, guaranteedLoansClear: 'YES' });
    expect(kpi(r, 'Saakh score')).toBe(7.9);
    expect(kpi(r, 'Recommended amount')).toBe(419000);
  });
});
