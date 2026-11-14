import { computeLoanEmi } from '../../../src/modules/society-calculator/engine/loan.engine';
import { buildRules, defaultRules, loadCalculatorRules } from '../../../src/modules/society-calculator/engine/rules';
import { calculateConstantEmi } from '../../../src/modules/loan/services-v2/loan-rb-schedule.util';

const rules = defaultRules('2026-11-14');
const d = (s: string) => new Date(`${s}T00:00:00`);

describe('society-calculator / loan EMI (SOP sections 4-6)', () => {
  it('300,000 / 12 % / 40 months applied 15-Jun-2026 (Slot 2) = EMI 9,188 (SOP 6.5)', () => {
    const r = computeLoanEmi({ loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15' }, rules);
    expect(r.slot.slot).toBe(2);
    expect(r.slot.interestDelayMonths).toBe(2);
    expect(r.monthlyPrincipal).toBe(7500);
    expect(r.totalRbInterest).toBe(61500);
    expect(r.delayInterest).toBe(6000);
    expect(r.totalInterestForEmi).toBe(67500);
    expect(r.monthlyInterestUnrounded).toBe(1687.5);
    expect(r.monthlyInterest).toBe(1688); // NEAREST: 1687.50 -> 1688
    expect(r.emi).toBe(9188);
    expect(r.totalPayable).toBe(367520);
  });

  it('is exactly what the real loan engine returns for the same inputs', () => {
    const real = calculateConstantEmi(300000, 12, 40, d('2026-06-15'), 1, 2, 'NEAREST', 25, 5, 0);
    const r = computeLoanEmi({ loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15' }, rules);
    expect(r.emi).toBe(real.constantEMI);
    expect(r.monthlyInterest).toBe(real.monthlyInterestForEMI);
    expect(r.totalInterestForEmi).toBe(real.totalInterestForEMI);
  });

  it('Slot 1 early / late / Slot 2 follow the 25th-5th window (SOP 4.5)', () => {
    const slot = (date: string) => computeLoanEmi({ loanAmount: 100000, annualRate: 12, installments: 12, applicationDate: date }, rules).slot;
    expect(slot('2026-06-03')).toMatchObject({ slot: 1, subSlot: 'EARLY_MONTH', interestDelayMonths: 1, firstDueDelayMonths: 1 });
    expect(slot('2026-06-28')).toMatchObject({ slot: 1, subSlot: 'LATE_MONTH', interestDelayMonths: 1, firstDueDelayMonths: 2 });
    expect(slot('2026-06-15')).toMatchObject({ slot: 2, subSlot: null, interestDelayMonths: 2, firstDueDelayMonths: 2 });
  });

  it('Slot 1 costs less per month than Slot 2 on the same loan (SOP 6.6)', () => {
    const s1 = computeLoanEmi({ loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-03' }, rules);
    const s2 = computeLoanEmi({ loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15' }, rules);
    expect(s1.delayInterest).toBe(3000);
    expect(s1.emi).toBeLessThan(s2.emi);
  });

  it('first due month follows the disbursement month plus the slot delay', () => {
    const r = computeLoanEmi({
      loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15', disbursementDate: '2026-06-27', graceDay: 15,
    }, rules);
    expect(r.firstDueMonth).toBe('2026-08');
    expect(r.lastDueMonth).toBe('2029-11');
    expect(r.schedule[0].dueDate).toBe('2026-08-15');
    expect(r.schedule[39].dueDate).toBe('2029-11-15');
  });

  it('the installment table adds up: principal = loan amount, last closing balance 0', () => {
    const r = computeLoanEmi({ loanAmount: 100000, annualRate: 12, installments: 3, applicationDate: '2026-06-15' }, rules);
    const principal = r.schedule.reduce((s, x) => s + x.principal, 0);
    expect(Math.round(principal * 100) / 100).toBe(100000);
    expect(r.schedule[2].closingBalance).toBe(0);
    // ES-407 rule: 100000 over 3 = 33333.33 + 33333.33 + 33333.34
    expect(r.schedule.map((x) => x.principal)).toEqual([33333.33, 33333.33, 33333.34]);
  });

  it('rounding modes (SOP 6.5): NEAREST 1688, UP 1688, DOWN 1687, NONE 1687.5', () => {
    const at = (roundingMode: any) => computeLoanEmi({ loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15', roundingMode }, rules).monthlyInterest;
    expect(at('NEAREST')).toBe(1688);
    expect(at('UP')).toBe(1688);
    expect(at('DOWN')).toBe(1687);
    expect(at('NONE')).toBe(1687.5);
  });

  it('carried interest from a previous agreement is added before dividing (SOP 12.4)', () => {
    const r = computeLoanEmi({ loanAmount: 277500, annualRate: 12, installments: 30, applicationDate: '2026-12-15', carriedInterest: 7000 }, rules);
    expect(r.carriedInterest).toBe(7000);
    expect(r.totalInterestForEmi).toBe(r.totalRbInterest + r.delayInterest + 7000);
  });

  it('shows the bank-style EMI next to the society EMI (SOP 6.7)', () => {
    const r = computeLoanEmi({ loanAmount: 300000, annualRate: 12, installments: 40, applicationDate: '2026-06-15' }, rules);
    expect(r.bankStyle.emi).toBe(9136.68);
    expect(r.bankStyle.emiDifference).toBe(51.32);
  });

  it('the Baseline of the shared Gemini sheet reproduces: 300,000 / 3,750 monthly principal (80 months) slot 2 -> interest 1,594, EMI 5,344', () => {
    const r = computeLoanEmi({ loanAmount: 300000, annualRate: 12, installments: 80, applicationDate: '2026-06-15' }, rules);
    expect(r.monthlyPrincipal).toBe(3750);
    expect(r.monthlyInterest).toBe(1594);
    expect(r.emi).toBe(5344);
  });

  it('refuses bad input with a clear message instead of NaN', () => {
    const bad = (over: any) => () => computeLoanEmi({ loanAmount: 100000, annualRate: 12, installments: 12, applicationDate: '2026-06-15', ...over }, rules);
    expect(bad({ loanAmount: 0 })).toThrow(/Loan amount/);
    expect(bad({ loanAmount: NaN })).toThrow(/Loan amount/);
    expect(bad({ annualRate: -1 })).toThrow(/Interest rate/);
    expect(bad({ annualRate: 99 })).toThrow(/Interest rate/);
    expect(bad({ installments: 0 })).toThrow(/installments/);
    expect(bad({ installments: 2.5 })).toThrow(/installments/);
    expect(bad({ installments: 100000 })).toThrow(/installments/);
    expect(bad({ applicationDate: '15-06-2026' })).toThrow(/YYYY-MM-DD/);
    expect(bad({ applicationDate: '2026-02-31' })).toThrow(/real calendar date/);
    expect(bad({ carriedInterest: -5 })).toThrow(/Carried interest/);
  });

  it('a 0 % loan has no interest and EMI = principal share', () => {
    const r = computeLoanEmi({ loanAmount: 12000, annualRate: 0, installments: 12, applicationDate: '2026-06-15' }, rules);
    expect(r.monthlyInterest).toBe(0);
    expect(r.emi).toBe(1000);
  });
});

describe('society-calculator / live rules', () => {
  it('an empty database gives the documented fallbacks of the real screens', () => {
    const r = buildRules(undefined, {});
    expect(r.loanTypes.RLN.rate).toBe(12);
    expect(r.loanTypes.ELN.rate).toBe(9);
    expect(r.loanTypes.RLN.smPct).toBe(1);
    expect(r.loanTypes.RLN.smDiv).toBe(4);
    expect(r.slot).toEqual({ startDay: 25, endDay: 5, slot1DelayMonths: 1, slot2DelayMonths: 2 });
    expect(r.roundingMode).toBe('NEAREST');
    expect(r.loanAgainstRd).toEqual({ pct: 90, ceiling: 500000 });
    expect(r.penaltyEnabled).toBe(false);
  });

  it('reads the live values (the 2026-11-13 database)', () => {
    const r = buildRules(
      { rlnrate: '12.00', elnrate: '9.00', rlnpenalrate: '15.00', rlngracedays: 15, rlnsmpct: '1.00', rlnsmdiv: '4.00',
        rlnmaxloanamt: '1000000', rlnmaxnoinst: '120', loanagainstdeppercent: '0', elnmaxloanamt: '1000000' },
      { RULE_TIERED_LOAN_PENALTY_ENABLED: 'true', RULE_LOAN_ROUNDING_MODE: 'nearest', RULE_RD_OPENING_BALANCE_RATE: '7' },
    );
    expect(r.loanTypes.RLN).toMatchObject({ rate: 12, penalRate: 15, graceDays: 15, smPct: 1, smDiv: 4, maxAmount: 1000000, maxInstallments: 120 });
    expect(r.penaltyEnabled).toBe(true);
    expect(r.roundingMode).toBe('NEAREST');
    expect(r.loanAgainstRd).toEqual({ pct: 90, ceiling: 1000000 }); // 0 % on the card -> 90
    expect(r.rd.rate).toBe(7);
  });

  it('an unknown rounding mode or a broken table never fails the calculator', async () => {
    expect(buildRules({}, { RULE_LOAN_ROUNDING_MODE: 'SIDEWAYS' }).roundingMode).toBe('NEAREST');
    const broken = { query: jest.fn().mockRejectedValue(new Error('relation does not exist')) };
    const r = await loadCalculatorRules(broken as any);
    expect(r.loanTypes.RLN.rate).toBe(12);
  });
});
