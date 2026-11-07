import { RD_RULE_DEFAULTS, RD_RULE_KEYS, RD_BOOLEAN_RULE_KEYS, RD_NUMERIC_RULE_KEYS, RdRules } from '../../../src/modules/rd/rd-business-rules';
import { remainingMonthsInFinancialYear, installmentInterest, buildRdChart, fullYearInstallmentInterest } from '../../../src/modules/rd/rd-interest-chart';
import { calculateRdInstallmentInterest } from '../../../src/modules/rd/rd-installment-interest-calculator';
import { calculateOpeningBalanceInterest } from '../../../src/modules/rd/rd-opening-balance-interest';
import { classifyInstallments, evaluateRdPaymentPattern, InstallmentRecord } from '../../../src/modules/rd/rd-pattern-engine';
import { monthsBetween, toDate, toDateOnlyString } from '../../../src/modules/rd/rd-date-math';

const d = (y: number, m: number, day = 1) => new Date(y, m - 1, day);

describe('rd/date math', () => {
  it('monthsBetween counts calendar months across years', () => {
    expect(monthsBetween(d(2026, 4), d(2026, 4))).toBe(0); expect(monthsBetween(d(2026, 4), d(2027, 3))).toBe(11); expect(monthsBetween(d(2026, 6), d(2026, 4))).toBe(-2);
  });
  it('monthsBetween ignores the day of the month', () => expect(monthsBetween(d(2026, 4, 30), d(2026, 5, 1))).toBe(1));
  it('toDate keeps a Date and parses text', () => { const x = new Date(); expect(toDate(x)).toBe(x); expect(toDate('2026-04-01').getFullYear()).toBe(2026); });
  it('toDateOnlyString zero pads', () => expect(toDateOnlyString(d(2026, 1, 5))).toBe('2026-01-05'));
});

describe('rd/rule defaults', () => {
  it('has 11 rules, split into numeric and boolean keys', () => {
    expect(RD_RULE_KEYS).toHaveLength(11); expect(RD_NUMERIC_RULE_KEYS.length + RD_BOOLEAN_RULE_KEYS.length).toBe(11);
    expect(RD_BOOLEAN_RULE_KEYS.sort()).toEqual(['RULE_RD_ALLOW_INITIAL_MISS_RECOVERY', 'RULE_RD_ALLOW_LATER_MISS_RECOVERY', 'RULE_RD_ALLOW_MULTIPLE_GAPS']);
  });
  it('documented defaults: min 200 a month, 7% on opening balance, 1000 stays after withdrawal', () => {
    expect(RD_RULE_DEFAULTS).toMatchObject({ RULE_RD_MIN_MONTHLY_AMOUNT: 200, RULE_RD_OPENING_BALANCE_RATE: 7, RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL: 1000, RULE_RD_ALLOW_MULTIPLE_GAPS: false });
  });
});

describe('rd/interest chart (financial year April to March)', () => {
  it('April has 12 remaining months, March has 1', () => { expect(remainingMonthsInFinancialYear(4)).toBe(12); expect(remainingMonthsInFinancialYear(12)).toBe(4); expect(remainingMonthsInFinancialYear(1)).toBe(3); expect(remainingMonthsInFinancialYear(3)).toBe(1); });
  it('an invalid month is an error', () => { for (const m of [0, 13, -1, 4.5]) expect(() => remainingMonthsInFinancialYear(m)).toThrow(/Invalid calendar month/); });
  it('installment interest = amount x rate x months/12, to paise', () => {
    expect(installmentInterest(1000, 12, 12)).toBe(120); expect(installmentInterest(1000, 12, 6)).toBe(60); expect(installmentInterest(333, 7, 5)).toBe(9.71);
  });
  it('zero rate, zero months and zero amount give zero', () => { expect(installmentInterest(1000, 0, 12)).toBe(0); expect(installmentInterest(1000, 12, 0)).toBe(0); expect(installmentInterest(0, 12, 12)).toBe(0); });
  it('the chart has 12 rows in financial year order with falling remaining months', () => {
    const c = buildRdChart(1000, 12);
    expect(c.map((r) => r.calendarMonth)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]); expect(c.map((r) => r.remainingMonths)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(c[0]).toMatchObject({ monthLabel: 'April', interest: 120 }); expect(c[11]).toMatchObject({ monthLabel: 'March', interest: 10 });
  });
  it('a full year of 1000 at 12% earns 78 months x 1000 x 1% = 780', () => expect(fullYearInstallmentInterest(1000, 12)).toBe(780));
  it('full year interest equals the sum of the chart rows', () => {
    const c = buildRdChart(333, 7.5); expect(fullYearInstallmentInterest(333, 7.5)).toBe(Math.round(c.reduce((s, r) => s + r.interest, 0) * 100) / 100);
  });
});

describe('rd/calculateRdInstallmentInterest', () => {
  const inst = (due: Date, paid: Date, amt = 1000) => ({ dueDate: due, paidDate: paid, paidAmount: amt });
  const fyEnd = d(2027, 3, 31);
  it('eligible: interest counts from the due month even when paid late', () => {
    const r = calculateRdInstallmentInterest([inst(d(2026, 4), d(2026, 6, 10))], 12, true, fyEnd);
    expect(r.rows[0].remainingMonthsUsed).toBe(12); expect(r.totalInterest).toBe(120);
  });
  it('not eligible: interest counts only from the month actually paid', () => {
    const r = calculateRdInstallmentInterest([inst(d(2026, 4), d(2026, 6, 10))], 12, false, fyEnd);
    expect(r.rows[0].remainingMonthsUsed).toBe(10); expect(r.totalInterest).toBe(100);
  });
  it('paid early (before the due month) earns from the month it was actually paid', () => {
    const r = calculateRdInstallmentInterest([inst(d(2026, 6), d(2026, 5, 20))], 12, true, fyEnd); expect(r.rows[0].remainingMonthsUsed).toBe(11);
  });
  it('a payment after the financial year end earns nothing', () => {
    const r = calculateRdInstallmentInterest([inst(d(2027, 3), d(2027, 4, 5))], 12, false, fyEnd); expect(r.rows[0]).toMatchObject({ remainingMonthsUsed: 0, interest: 0 });
  });
  it('totals the rows to paise and handles an empty list', () => {
    expect(calculateRdInstallmentInterest([], 12, true, fyEnd).totalInterest).toBe(0);
    const r = calculateRdInstallmentInterest([inst(d(2026, 4), d(2026, 4), 333), inst(d(2026, 5), d(2026, 5), 333)], 7, true, fyEnd);
    expect(r.totalInterest).toBe(Math.round(r.rows.reduce((s, x) => s + x.interest, 0) * 100) / 100);
  });
  it('accepts ISO strings for the dates', () => {
    expect(calculateRdInstallmentInterest([{ dueDate: '2026-04-01', paidDate: '2026-04-01', paidAmount: 1000 }], 12, true, '2027-03-31').totalInterest).toBe(120);
  });
  it('a payment dated in the last month of the year (March) counts one month', () => {
    expect(calculateRdInstallmentInterest([inst(d(2027, 3), d(2027, 3, 15))], 12, true, fyEnd).rows[0].remainingMonthsUsed).toBe(1);
  });
});

describe('rd/calculateOpeningBalanceInterest', () => {
  const fyEnd = d(2027, 3, 31);
  it('no events, no interest', () => expect(calculateOpeningBalanceInterest([], 7, fyEnd)).toEqual({ periods: [], totalInterest: 0 }));
  it('one opening balance held for the whole year earns the annual rate', () => {
    const r = calculateOpeningBalanceInterest([{ eventDate: d(2026, 4), eventType: 'OPENING', resultingBalance: 10000 }], 7, fyEnd);
    expect(r.periods[0].monthsHeld).toBe(12); expect(r.totalInterest).toBe(700);
  });
  it('a change part way through splits the year into periods', () => {
    const r = calculateOpeningBalanceInterest([{ eventDate: d(2026, 4), eventType: 'OPENING', resultingBalance: 10000 }, { eventDate: d(2026, 10), eventType: 'WITHDRAWAL', resultingBalance: 4000 }], 12, fyEnd);
    expect(r.periods.map((p) => p.monthsHeld)).toEqual([6, 6]); expect(r.totalInterest).toBe(600 + 240);
  });
  it('a loan addition counts from the following month', () => {
    const r = calculateOpeningBalanceInterest([{ eventDate: d(2026, 4), eventType: 'OPENING', resultingBalance: 1000 }, { eventDate: d(2026, 6, 15), eventType: 'LOAN_ADDITION', resultingBalance: 2000 }], 12, fyEnd);
    expect(r.periods[1].fromDate).toEqual(d(2026, 7)); expect(r.periods[0].monthsHeld).toBe(3);
  });
  it('events given out of order are sorted by month', () => {
    const r = calculateOpeningBalanceInterest([{ eventDate: d(2026, 10), eventType: 'W', resultingBalance: 4000 }, { eventDate: d(2026, 4), eventType: 'O', resultingBalance: 10000 }], 12, fyEnd);
    expect(r.periods[0].balance).toBe(10000);
  });
  it('an event dated after the financial year end earns nothing (months are never negative)', () => {
    const r = calculateOpeningBalanceInterest([{ eventDate: d(2027, 6), eventType: 'O', resultingBalance: 5000 }], 12, fyEnd); expect(r.periods[0].monthsHeld).toBe(0); expect(r.totalInterest).toBe(0);
  });
  it('two events in the same month: the earlier one holds for zero months', () => {
    const r = calculateOpeningBalanceInterest([{ eventDate: d(2026, 4, 2), eventType: 'O', resultingBalance: 5000 }, { eventDate: d(2026, 4, 20), eventType: 'W', resultingBalance: 3000 }], 12, fyEnd);
    expect(r.periods[0].monthsHeld).toBe(0); expect(r.periods[1].monthsHeld).toBe(12);
  });
});

describe('rd/payment pattern engine', () => {
  const rules: RdRules = { ...RD_RULE_DEFAULTS };
  const rec = (n: number, paid: 'ontime' | 'late' | 'missed' | number, amount = 500): InstallmentRecord => {
    const due = d(2026, 4 + n);
    if (paid === 'missed') return { dueDate: due, expectedAmount: amount, paidAmount: 0, paidDate: null };
    if (paid === 'ontime') return { dueDate: due, expectedAmount: amount, paidAmount: amount, paidDate: due };
    const lateBy = paid === 'late' ? 1 : paid;
    return { dueDate: due, expectedAmount: amount, paidAmount: amount, paidDate: d(2026, 4 + n + lateBy) };
  };
  const year = (spec: Array<'ontime' | 'late' | 'missed' | number>) => spec.map((p, i) => rec(i, p));
  const allOnTime = () => year(Array(12).fill('ontime'));

  it('classify: on time, late (months late), missed, and a short payment counts as missed', () => {
    const f = classifyInstallments([rec(0, 'ontime'), rec(1, 2), rec(2, 'missed'), { dueDate: d(2026, 7), expectedAmount: 500, paidAmount: 400, paidDate: d(2026, 7) }]);
    expect(f.map((x) => x.status)).toEqual(['PAID_ON_TIME', 'PAID_LATE', 'MISSED', 'MISSED']); expect(f[1].monthsLate).toBe(2); expect(f[2].monthsLate).toBeNull();
  });
  it('a payment before the due month counts as on time', () => {
    expect(classifyInstallments([{ dueDate: d(2026, 6), expectedAmount: 500, paidAmount: 500, paidDate: d(2026, 5) }])[0].status).toBe('PAID_ON_TIME');
  });
  it('a paid amount above the expected amount is fine', () => {
    expect(classifyInstallments([{ dueDate: d(2026, 6), expectedAmount: 500, paidAmount: 900, paidDate: d(2026, 6) }])[0].status).toBe('PAID_ON_TIME');
  });
  it('twelve on time payments: FULLY_REGULAR and eligible', () => {
    const r = evaluateRdPaymentPattern(allOnTime(), rules);
    expect(r).toMatchObject({ detectedPattern: 'FULLY_REGULAR', autoEligibleFullInterest: true, totalPaidOnTime: 12, maxConsecutiveOnTime: 12, gaps: [], disqualifyingReasons: [] });
  });
  it('one late payment in the middle (recovered) is still eligible', () => {
    const r = evaluateRdPaymentPattern(year(['ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']), rules);
    expect(r.detectedPattern).toBe('LATER_GAP_RECOVERED'); expect(r.autoEligibleFullInterest).toBe(true);
  });
  it('a recovered gap at the start is INITIAL_GAP_RECOVERED', () => {
    const r = evaluateRdPaymentPattern(year(['late', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']), rules);
    expect(r.detectedPattern).toBe('INITIAL_GAP_RECOVERED'); expect(r.gaps[0]).toMatchObject({ startIndex: 0, length: 2, recovered: true });
  });
  it('an unpaid instalment makes the gap unrecovered and disqualifies', () => {
    const r = evaluateRdPaymentPattern(year(['ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'missed', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']), rules);
    expect(r.detectedPattern).toBe('GAP_UNRECOVERED'); expect(r.autoEligibleFullInterest).toBe(false); expect(r.disqualifyingReasons.join(' ')).toMatch(/remain unpaid/);
  });
  it('more non-on-time instalments than the tolerance disqualifies', () => {
    const r = evaluateRdPaymentPattern(year(['late', 'ontime', 'late', 'ontime', 'late', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']), rules);
    expect(r.totalNonOnTime).toBe(4); expect(r.disqualifyingReasons.join(' ')).toMatch(/exceeding the configured tolerance of 3/);
  });
  it('a gap longer than the maximum disqualifies', () => {
    const r = evaluateRdPaymentPattern(year(['ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'late', 'late', 'late', 'late', 'ontime', 'ontime', 'ontime']), rules);
    expect(r.longestGapMonths).toBe(4); expect(r.disqualifyingReasons.join(' ')).toMatch(/Longest gap was 4/);
  });
  it('several separate gaps are refused unless multiple gaps are allowed', () => {
    const spec: any = ['ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'ontime'];
    expect(evaluateRdPaymentPattern(year(spec), rules).detectedPattern).toBe('MULTIPLE_GAPS');
    expect(evaluateRdPaymentPattern(year(spec), rules).disqualifyingReasons.join(' ')).toMatch(/multiple gaps are not allowed/);
    expect(evaluateRdPaymentPattern(year(spec), { ...rules, RULE_RD_ALLOW_MULTIPLE_GAPS: true }).autoEligibleFullInterest).toBe(true);
  });
  it('policy switches for initial and later recovery', () => {
    const initial = year(['late', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']);
    expect(evaluateRdPaymentPattern(initial, { ...rules, RULE_RD_ALLOW_INITIAL_MISS_RECOVERY: false }).disqualifyingReasons.join(' ')).toMatch(/start of the year/);
    const later = year(['ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']);
    expect(evaluateRdPaymentPattern(later, { ...rules, RULE_RD_ALLOW_LATER_MISS_RECOVERY: false }).disqualifyingReasons.join(' ')).toMatch(/later in the year/);
  });
  it('a slow recovery (more months late than allowed) disqualifies', () => {
    const r = evaluateRdPaymentPattern(year(['ontime', 'ontime', 'ontime', 'ontime', 4, 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']), rules);
    expect(r.disqualifyingReasons.join(' ')).toMatch(/took 4 month\(s\) to clear/);
  });
  it('too few regular payments after a recovery disqualifies while months remain', () => {
    const r = evaluateRdPaymentPattern(year(['ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'late', 'ontime', 'ontime', 'ontime']), { ...rules, RULE_RD_ALLOW_MULTIPLE_GAPS: true });
    expect(r.disqualifyingReasons.join(' ')).toMatch(/regular payment\(s\) followed the recovery/);
  });
  it('a gap needs a minimum on-time run elsewhere in the year', () => {
    const r = evaluateRdPaymentPattern(year(['late', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'late', 'late', 'ontime', 'ontime', 'late', 'ontime']), { ...rules, RULE_RD_MAX_MISSED_INSTALLMENTS: 12, RULE_RD_ALLOW_MULTIPLE_GAPS: true, RULE_RD_MAX_PAYMENT_GAP_MONTHS: 12, RULE_RD_MIN_REGULAR_AFTER_RECOVERY: 0 });
    expect(r.disqualifyingReasons.join(' ')).toMatch(/Longest run of on-time payments was 2/);
  });
  it('the counts add up: on time + late + missing = total due', () => {
    const r = evaluateRdPaymentPattern(year(['ontime', 'late', 'missed', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime']), rules);
    expect(r.totalPaidOnTime + r.totalPaidLate + r.totalStillMissing).toBe(r.totalDue);
  });
});
