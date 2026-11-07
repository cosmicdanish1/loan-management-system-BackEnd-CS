import { LoanPaymentFlagService, WatchedLoan, EvaluateInput, DEFAULT_OLD_EMI_FLAG_TOLERANCE } from '../../../src/modules/loan/services-v2/loan-payment-flag.service';
import { LoanMonthEndService } from '../../../src/modules/loan/services-v2/loan-month-end.service';

const w = (o: Partial<WatchedLoan> = {}): WatchedLoan => ({
  mbno: '5', loancaseno: '77', loantype: 'RLN', oldPrincipal: 2000, oldInterest: 500, newPrincipal: 3000, newInterest: 800,
  startDate: new Date(2026, 0, 10), watchUntil: new Date(2026, 1, 28), ...o,
});
const ev = (total: number, o: Partial<EvaluateInput> = {}): EvaluateInput => ({ watched: w(), total, phase: 'IN_WINDOW', priorOldSized: 0, tolerance: 10, ...o });
const evaluate = LoanPaymentFlagService.evaluate;

describe('loan/LoanPaymentFlagService.evaluate (old EMI after consolidation)', () => {
  it('a normal new-loan EMI is not flagged', () => expect(evaluate(ev(3800))).toBeNull());
  it('an unrelated amount is not flagged', () => expect(evaluate(ev(1234))).toBeNull());
  it('exactly the old EMI inside the window is not flagged the first time (it is the expected deduction)', () => {
    expect(evaluate(ev(2500))).toBeNull();
  });
  it('the old EMI again inside the window is SECOND_OLD_EMI', () => expect(evaluate(ev(2500, { priorOldSized: 1 }))).toBe('SECOND_OLD_EMI'));
  it('close to the old EMI but not equal is NEAR_OLD_EMI (within tolerance)', () => {
    expect(evaluate(ev(2505))).toBe('NEAR_OLD_EMI'); expect(evaluate(ev(2510))).toBe('NEAR_OLD_EMI'); expect(evaluate(ev(2511))).toBeNull();
  });
  it('an amount equal to both old and new EMI is IDENTICAL_EMI', () => {
    const watched = w({ oldPrincipal: 2000, oldInterest: 500, newPrincipal: 2000, newInterest: 500 });
    expect(evaluate(ev(2500, { watched }))).toBe('IDENTICAL_EMI');
  });
  it('identical totals but a split that matches only the new loan is not flagged', () => {
    const watched = w({ oldPrincipal: 2000, oldInterest: 500, newPrincipal: 1800, newInterest: 700 });
    expect(evaluate(ev(2500, { watched, principal: 1800, interest: 700 }))).toBeNull();
  });
  it('old + new together is COMBINED_EMI in any phase', () => {
    expect(evaluate(ev(6300))).toBe('COMBINED_EMI'); expect(evaluate(ev(6300, { phase: 'AFTER_WINDOW' }))).toBe('COMBINED_EMI');
  });
  it('after the window: old EMI is flagged, the new EMI is not', () => {
    expect(evaluate(ev(2500, { phase: 'AFTER_WINDOW' }))).toBe('OLD_EMI_AFTER_WINDOW'); expect(evaluate(ev(3800, { phase: 'AFTER_WINDOW' }))).toBeNull();
  });
  it('after the window NEAR matches are not flagged', () => expect(evaluate(ev(2505, { phase: 'AFTER_WINDOW' }))).toBeNull());
  it('zero or negative amounts and zero EMIs never flag', () => {
    expect(evaluate(ev(0))).toBeNull(); expect(evaluate(ev(-2500))).toBeNull(); expect(evaluate(ev(2500, { watched: w({ oldPrincipal: 0, oldInterest: 0 }) }))).toBeNull();
    expect(evaluate(ev(2500, { watched: w({ newPrincipal: 0, newInterest: 0 }) }))).toBeNull();
  });
  it('a rupee of difference counts as equal, two do not', () => {
    expect(evaluate(ev(2500.9, { priorOldSized: 1 }))).toBe('SECOND_OLD_EMI'); expect(evaluate(ev(2502, { priorOldSized: 1 }))).toBe('NEAR_OLD_EMI');
  });
  it('default tolerance is 10 rupees', () => expect(DEFAULT_OLD_EMI_FLAG_TOLERANCE).toBe(10));
});

describe('loan/LoanPaymentFlagService.phaseFor and describe', () => {
  const until = new Date(2026, 1, 28);
  it('on or before the watch date: IN_WINDOW', () => { expect(LoanPaymentFlagService.phaseFor(new Date(2026, 1, 28), until)).toBe('IN_WINDOW'); expect(LoanPaymentFlagService.phaseFor(new Date(2026, 0, 1), until)).toBe('IN_WINDOW'); });
  it('up to two calendar months after: AFTER_WINDOW', () => {
    expect(LoanPaymentFlagService.phaseFor(new Date(2026, 2, 1), until)).toBe('AFTER_WINDOW'); expect(LoanPaymentFlagService.phaseFor(new Date(2026, 3, 30), until)).toBe('AFTER_WINDOW');
  });
  it('later than that: no phase (no flag)', () => expect(LoanPaymentFlagService.phaseFor(new Date(2026, 4, 1), until)).toBeNull());
  it('year end rollover works (watch until Dec, payment in Feb)', () => {
    expect(LoanPaymentFlagService.phaseFor(new Date(2027, 1, 10), new Date(2026, 11, 20))).toBe('AFTER_WINDOW');
  });
  it('every code has a message that tells the user how to correct it', () => {
    for (const code of ['IDENTICAL_EMI', 'NEAR_OLD_EMI', 'SECOND_OLD_EMI', 'OLD_EMI_AFTER_WINDOW', 'COMBINED_EMI'] as const) {
      const m = LoanPaymentFlagService.describe(code, 'PAYMENT', ev(2500)); expect(m).toContain('Journal/Transfer Entry'); expect(m).toContain('₹');
    }
  });
  it('payment vs demand messages differ in tense', () => {
    expect(LoanPaymentFlagService.describe('NEAR_OLD_EMI', 'PAYMENT', ev(2505))).toContain('It was recorded as a normal payment');
    expect(LoanPaymentFlagService.describe('NEAR_OLD_EMI', 'DEMAND', ev(2505))).toContain('It will be applied as a normal payment');
  });
});

describe('loan/LoanPaymentFlagService.checkPayment / tolerance', () => {
  const mkDs = (rows: Record<string, any[]>) => ({ query: jest.fn(async (sql: string) => (/RULE_LOAN_OLD_EMI_FLAG_TOLERANCE/.test(sql) ? rows.tol ?? [] : /is_payroll_lag_credit = true/.test(sql) ? rows.lag ?? [{ c: 0 }] : [])) } as any);
  const svc = (rows: Record<string, any[]> = {}) => new LoanPaymentFlagService(mkDs(rows));
  const ds0: any = { query: async (sql: string) => (/is_payroll_lag_credit = true/.test(sql) ? [{ c: 1 }] : /RULE_LOAN_OLD_EMI_FLAG_TOLERANCE/.test(sql) ? [] : []) };
  const loan = (o: any = {}) => ({ mbno: '5', loantype: 'RLN', instal_amt: 3000, intt_amount: 800, payment_date: '2026-01-10', payroll_lag_watch_until: '2026-02-28', payroll_lag_old_principal: 2000, payroll_lag_old_interest: 500, ...o });
  it('tolerance: configured value, else default 10; negative or text fall back', async () => {
    expect(await svc({ tol: [{ value: '25' }] }).getTolerance()).toBe(25);
    for (const v of ['-1', 'abc']) expect(await svc({ tol: [{ value: v }] }).getTolerance()).toBe(10);
    expect(await svc().getTolerance()).toBe(10);
  });
  it('a loan without a payroll lag watch is never flagged', async () => {
    expect(await svc().checkPayment(ds0, loan({ payroll_lag_watch_until: null }), '77', 2500, new Date(2026, 1, 1))).toBeNull();
    expect(await svc().checkPayment(ds0, loan({ payroll_lag_old_principal: 0, payroll_lag_old_interest: 0 }), '77', 2500, new Date(2026, 1, 1))).toBeNull();
  });
  it('a payment long after the watch window is not flagged', async () => {
    expect(await svc().checkPayment(ds0, loan(), '77', 2500, new Date(2026, 8, 1))).toBeNull();
  });
  it('a second old-sized payment inside the window gets a flag with the amount', async () => {
    const f = await svc({ lag: [{ c: 1 }] }).checkPayment(ds0, loan(), '77', 2500, new Date(2026, 1, 1));
    expect(f).toMatchObject({ code: 'SECOND_OLD_EMI', loancaseno: '77', loantype: 'RLN', amount: 2500 });
  });
});

describe('loan/LoanMonthEndService', () => {
  const mk = (rows: any[] = []) => {
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
      query: jest.fn(async (sql: string) => (/FROM loan_master/.test(sql) ? rows : [])) };
    const ds: any = { createQueryRunner: jest.fn(() => qr), query: jest.fn().mockResolvedValue([]) };
    return { svc: new LoanMonthEndService(ds), qr, ds };
  };
  it('captures one row per member with active loans and commits', async () => {
    const t = mk([{ mbno: '5', regular_balance: '1000.5', emergency_balance: '200' }, { mbno: '6', regular_balance: '0', emergency_balance: null }]);
    const r = await t.svc.captureMonthEndSnapshot(3, 2026);
    expect(r).toEqual({ success: true, captured: 2, message: 'Captured 2 member balances for 3/2026' });
    const ins = t.qr.query.mock.calls.filter((c: any[]) => /INSERT INTO loan_monthly_balance/.test(c[0]));
    expect(ins[0][1]).toEqual(['5', 3, 2026, 1000.5, 200]); expect(ins[1][1]).toEqual(['6', 3, 2026, 0, 0]); expect(t.qr.commitTransaction).toHaveBeenCalled();
  });
  it('re-running the same month overwrites (ON CONFLICT DO UPDATE), it does not duplicate', async () => {
    const t = mk([{ mbno: '5', regular_balance: '1', emergency_balance: '1' }]); await t.svc.captureMonthEndSnapshot(3, 2026);
    expect(t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_monthly_balance/.test(c[0]))[0]).toContain('ON CONFLICT (mbno, snapshot_month, snapshot_year) DO UPDATE');
  });
  it('only loans with a balance above zero are captured', async () => {
    const t = mk(); await t.svc.captureMonthEndSnapshot(3, 2026);
    expect(t.qr.query.mock.calls[0][0]).toContain('WHERE balance > 0');
  });
  it('a failure rolls the snapshot back and releases', async () => {
    const t = mk([{ mbno: '5', regular_balance: '1', emergency_balance: '1' }]); t.qr.query.mockImplementation(async (sql: string) => { if (/INSERT/.test(sql)) throw new Error('x'); return [{ mbno: '5' }]; });
    await expect(t.svc.captureMonthEndSnapshot(3, 2026)).rejects.toThrow('Month-end snapshot failed: x'); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('month 13, month 0 and year 1800 are refused (they would write junk rows)', async () => {
    for (const [m, y] of [[13, 2026], [0, 2026], [3, 1800], [3, 9999]]) {
      const t = mk([{ mbno: '5', regular_balance: '1', emergency_balance: '1' }]);
      await expect(t.svc.captureMonthEndSnapshot(m, y)).rejects.toThrow(); expect(t.qr.query.mock.calls.some((c: any[]) => /INSERT INTO loan_monthly_balance/.test(c[0]))).toBe(false);
    }
  });
  it('a non numeric month is refused', async () => {
    await expect(mk().svc.captureMonthEndSnapshot('abc' as any, 2026)).rejects.toThrow();
  });
  it('reports read with bound month and year / member number', async () => {
    const t = mk(); await t.svc.getMonthlyBalanceReport(3, 2026); await t.svc.getMemberBalanceHistory("5' OR 1=1");
    expect(t.ds.query.mock.calls[0][1]).toEqual([3, 2026]); expect(t.ds.query.mock.calls[1][1]).toEqual(["5' OR 1=1"]);
  });
});
