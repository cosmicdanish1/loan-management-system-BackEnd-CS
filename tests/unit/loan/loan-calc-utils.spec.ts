import {
  round2, applyLoanRounding, isInSlot1Window, determineLoanSlot, buildReducingBalanceSchedule, calculateConstantEmi,
  firstDueMonthFromDisbursement, installmentDueMonth, persistRbSchedule, LOAN_ROUNDING_MODES,
} from '../../../src/modules/loan/services-v2/loan-rb-schedule.util';
import { interestHeadForLoanType, ALL_LOAN_INTEREST_HEADS, LOAN_INTEREST_PARENT_HEAD } from '../../../src/modules/loan/loan-interest-heads';
import { loanHeadOpeningSql } from '../../../src/modules/loan/loan-opening-balance';
import { isLoanPaymentModel } from '../../../src/modules/loan/services-v2/loan-payment-model';

const d = (s: string) => new Date(`${s}T00:00:00`);

describe('loan/round2 and rounding modes', () => {
  it('round2 rounds half up to paise', () => { expect(round2(1.005 + 1e-9)).toBe(1.01); expect(round2(2.344)).toBe(2.34); expect(round2(-1.239)).toBe(-1.24); });
  it('NONE keeps paise, NEAREST/UP/DOWN give whole rupees', () => {
    expect(applyLoanRounding(10.456, 'NONE')).toBe(10.46);
    expect(applyLoanRounding(10.5, 'NEAREST')).toBe(11); expect(applyLoanRounding(10.01, 'UP')).toBe(11); expect(applyLoanRounding(10.99, 'DOWN')).toBe(10);
  });
  it('an unknown mode behaves like NONE', () => expect(applyLoanRounding(10.456, 'XYZ' as any)).toBe(10.46));
  it('four modes are listed', () => expect(LOAN_ROUNDING_MODES).toEqual(['NONE', 'NEAREST', 'UP', 'DOWN']));
});

describe('loan/slot window and slot decision', () => {
  it('default window is day 25 to day 5 (wraps over month end)', () => {
    for (const day of [25, 28, 31, 1, 5]) expect(isInSlot1Window(day)).toBe(true);
    for (const day of [6, 15, 24]) expect(isInSlot1Window(day)).toBe(false);
  });
  it('a non wrapping window works (10 to 20)', () => {
    expect(isInSlot1Window(10, 10, 20)).toBe(true); expect(isInSlot1Window(21, 10, 20)).toBe(false); expect(isInSlot1Window(9, 10, 20)).toBe(false);
  });
  it('invalid configured days fall back to 25 / 5', () => {
    expect(isInSlot1Window(26, 0, 99)).toBe(true); expect(isInSlot1Window(15, NaN as any, -3)).toBe(false);
  });
  it('days 1-5: slot 1 early month, delay 1', () => {
    expect(determineLoanSlot(d('2026-03-03'))).toMatchObject({ slot: 1, subSlot: 'EARLY_MONTH', interestDelayMonths: 1, firstDueDelayMonths: 1, delayMonths: 1 });
  });
  it('days 25-31: slot 1 late month, first EMI one month later than the interest delay', () => {
    expect(determineLoanSlot(d('2026-03-27'))).toMatchObject({ slot: 1, subSlot: 'LATE_MONTH', interestDelayMonths: 1, firstDueDelayMonths: 2 });
  });
  it('days 6-24: slot 2, delay 2', () => {
    expect(determineLoanSlot(d('2026-03-15'))).toMatchObject({ slot: 2, subSlot: null, interestDelayMonths: 2, firstDueDelayMonths: 2 });
  });
  it('configured delays are used', () => {
    expect(determineLoanSlot(d('2026-03-15'), 1, 3).delayMonths).toBe(3);
  });
  it('boundary days 5, 6, 24, 25 land in the right slot', () => {
    expect(determineLoanSlot(d('2026-03-05')).slot).toBe(1); expect(determineLoanSlot(d('2026-03-06')).slot).toBe(2);
    expect(determineLoanSlot(d('2026-03-24')).slot).toBe(2); expect(determineLoanSlot(d('2026-03-25')).slot).toBe(1);
  });
});

describe('loan/due months', () => {
  it('first due month is the first of the month delayMonths after disbursement', () => {
    expect(firstDueMonthFromDisbursement(d('2026-03-20'), 2)).toEqual(new Date(2026, 4, 1));
    expect(firstDueMonthFromDisbursement(d('2026-12-20'), 2)).toEqual(new Date(2027, 1, 1));
  });
  it('installment n is n-1 months after the first', () => {
    const first = new Date(2026, 10, 1);
    expect(installmentDueMonth(first, 1)).toEqual(new Date(2026, 10, 1)); expect(installmentDueMonth(first, 3)).toEqual(new Date(2027, 0, 1));
  });
});

describe('loan/buildReducingBalanceSchedule', () => {
  it('equal principal, interest on the falling balance, last closing balance 0', () => {
    const { schedule, totalRBInterest } = buildReducingBalanceSchedule(120000, 12, 12);
    expect(schedule).toHaveLength(12); expect(schedule[0]).toEqual({ installmentNo: 1, openingBalance: 120000, rbInterest: 1200, principal: 10000, closingBalance: 110000 });
    expect(schedule[11]).toMatchObject({ openingBalance: 10000, rbInterest: 100, closingBalance: 0 }); expect(totalRBInterest).toBe(7800);
  });
  it('zero rate gives zero interest', () => { expect(buildReducingBalanceSchedule(1000, 0, 4).totalRBInterest).toBe(0); });
  it('principal column adds up to the loan amount for an uneven split (100000 over 3)', () => {
    const { schedule } = buildReducingBalanceSchedule(100000, 12, 3);
    const sum = schedule.reduce((s, r) => s + r.principal, 0);
    expect(round2(sum)).toBe(100000);
  });
  it('the schedule closes exactly to zero for an uneven split', () => {
    const { schedule } = buildReducingBalanceSchedule(100, 12, 3);
    expect(schedule[2].closingBalance).toBe(0);
    expect(round2(schedule[2].openingBalance - schedule[2].principal)).toBe(0);
  });
  it('a single installment repays everything with one month interest', () => {
    const { schedule } = buildReducingBalanceSchedule(5000, 12, 1);
    expect(schedule).toEqual([{ installmentNo: 1, openingBalance: 5000, rbInterest: 50, principal: 5000, closingBalance: 0 }]);
  });
  it('zero installments does not produce a schedule full of NaN', () => {
    const { schedule } = buildReducingBalanceSchedule(1000, 12, 0);
    expect(schedule.every((r) => Number.isFinite(r.principal))).toBe(true);
  });
});

describe('loan/calculateConstantEmi', () => {
  it('slot 1 early month, 120000 at 12% over 12: EMI = 10000 + (7800 + 1200 delay)/12', () => {
    const r = calculateConstantEmi(120000, 12, 12, d('2026-03-03'));
    expect(r).toMatchObject({ totalRBInterest: 7800, delayInterest: 1200, totalInterestForEMI: 9000, monthlyInterestForEMI: 750, monthlyPrincipal: 10000, constantEMI: 10750 });
  });
  it('slot 2 charges two months of delay interest', () => {
    const r = calculateConstantEmi(120000, 12, 12, d('2026-03-15'));
    expect(r.delayInterest).toBe(2400); expect(r.constantEMI).toBe(10850);
  });
  it('carried interest is added to the total and negative carried interest is ignored', () => {
    expect(calculateConstantEmi(120000, 12, 12, d('2026-03-03'), 1, 2, 'NONE', 25, 5, 600).totalInterestForEMI).toBe(9600);
    expect(calculateConstantEmi(120000, 12, 12, d('2026-03-03'), 1, 2, 'NONE', 25, 5, -600).totalInterestForEMI).toBe(9000);
  });
  it('rounding mode applies to the monthly interest only', () => {
    const r = calculateConstantEmi(100000, 11, 7, d('2026-03-03'), 1, 2, 'UP');
    expect(Number.isInteger(r.monthlyInterestForEMI)).toBe(true);
  });
  it('EMI x n covers principal plus total interest (within rounding of one paisa per installment)', () => {
    const r = calculateConstantEmi(250000, 10.5, 36, d('2026-03-15'));
    expect(Math.abs(r.constantEMI * 36 - (250000 + r.totalInterestForEMI))).toBeLessThan(36 * 0.02);
  });
  it('the EMI is rounded to paise', () => {
    const r = calculateConstantEmi(100000, 11, 7, d('2026-03-03'));
    expect(round2(r.constantEMI)).toBe(r.constantEMI);
  });
  it('zero rate: EMI is principal / n', () => { expect(calculateConstantEmi(12000, 0, 12, d('2026-03-03')).constantEMI).toBe(1000); });
});

describe('loan/persistRbSchedule', () => {
  it('replaces the stored schedule: one delete then one insert per row', async () => {
    const qr: any = { query: jest.fn().mockResolvedValue([]) };
    const { schedule } = buildReducingBalanceSchedule(1200, 12, 3);
    await persistRbSchedule(qr, '77', '5', 'RLN', schedule);
    expect(qr.query).toHaveBeenCalledTimes(4); expect(qr.query.mock.calls[0][0]).toContain('DELETE FROM loan_rb_schedule');
    expect(qr.query.mock.calls[1][1]).toEqual(['77', '5', 'RLN', 1, 1200, 12, 400, 800]);
  });
});

describe('loan/interest heads, opening-balance SQL, payment model', () => {
  it('RLN -> I1013, ALN (emergency) -> I1014, anything else -> parent I1002', () => {
    expect(interestHeadForLoanType('RLN')).toBe('I1013'); expect(interestHeadForLoanType(' aln ')).toBe('I1014');
    expect(interestHeadForLoanType('ELN')).toBe(LOAN_INTEREST_PARENT_HEAD); expect(interestHeadForLoanType(null)).toBe('I1002'); expect(interestHeadForLoanType(undefined)).toBe('I1002');
  });
  it('lists the parent and both child heads', () => expect(ALL_LOAN_INTEREST_HEADS).toEqual(['I1002', 'I1013', 'I1014']));
  it('opening balance SQL uses the member and kind it is given and stops at the first ledger entry', () => {
    const sql = loanHeadOpeningSql('m.mbno', 'true');
    expect(sql).toContain('lm.mbno = m.mbno'); expect(sql).toContain("'A1002'"); expect(sql).toContain("'A1047'"); expect(sql).toContain('MIN(l.trans_date)');
  });
  it('payment model accepts only SEPARATE_INTEREST', () => {
    expect(isLoanPaymentModel('SEPARATE_INTEREST')).toBe(true); expect(isLoanPaymentModel('COMBINED')).toBe(false); expect(isLoanPaymentModel(undefined)).toBe(false);
  });
});
