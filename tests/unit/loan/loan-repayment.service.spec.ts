import { BadRequestException } from '@nestjs/common';
import { LoanRepaymentService } from '../../../src/modules/loan/services-v2/loan-repayment.service';

const loanRow = (o: any = {}) => ({ mbno: '5', loantype: 'RLN', loan_amt: 100000, balance: 60000, instal_amt: 2000, no_of_instal: 60, penalrate: 0, gracedays: 0, payment_date: '2025-01-01', delay_months: 1, ...o });

function mk(loan: any | null = loanRow(), extra: (sql: string, p?: any[]) => any = () => undefined) {
  const calls: any[] = [];
  const route = (sql: string, p?: any[]) => {
    calls.push([sql, p]);
    const e = extra(sql, p); if (e !== undefined) return e;
    if (/FROM loan_master WHERE/.test(sql) && /SELECT mbno, loantype/.test(sql)) return loan ? [loan] : [];
    return [];
  };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn(async (s: string, p?: any[]) => route(s, p)) };
  const ds: any = { query: jest.fn(async (s: string, p?: any[]) => route(s, p)), createQueryRunner: jest.fn(() => qr) };
  const svc = new LoanRepaymentService(ds, {} as any, {} as any);
  return { svc, qr, ds, calls };
}
const dto = (o: any = {}) => ({ mbno: '5', loancaseno: '77', paymentAmount: 2000, ...o });
const explicit = (o: any = {}) => dto({ principalAmount: 1000, interestAmount: 100, penalAmount: 0, ...o });

describe('loan/LoanRepaymentService.recordLoanRepayment guards', () => {
  it('an unknown case is a 400 and the transaction is rolled back and released', async () => {
    const t = mk(null);
    await expect(t.svc.recordLoanRepayment(dto())).rejects.toThrow(/not found in loan_master/);
    expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled(); expect(t.qr.commitTransaction).not.toHaveBeenCalled();
  });
  it('the case, member and type filters are bound parameters', async () => {
    const t = mk(null); await t.svc.recordLoanRepayment(dto({ loancaseno: "7' OR '1'='1", loantype: 'RLN' })).catch(() => undefined);
    const c = t.qr.query.mock.calls[0]; expect(c[0]).not.toContain("OR '1'='1"); expect(c[1]).toEqual(["7' OR '1'='1", '5', 'RLN']);
  });
  it('payment of 0 or a negative amount is refused', async () => {
    for (const paymentAmount of [0, -100]) await expect(mk().svc.recordLoanRepayment(dto({ paymentAmount }))).rejects.toThrow(/greater than zero/);
  });
  it('a non numeric payment amount is refused (NaN must not pass the > 0 check)', async () => {
    await expect(mk().svc.recordLoanRepayment(dto({ paymentAmount: 'abc' as any }))).rejects.toThrow(BadRequestException);
  });
  it('an infinite or absurd payment is refused', async () => {
    await expect(mk().svc.recordLoanRepayment(dto({ paymentAmount: 1e12 }))).rejects.toThrow(BadRequestException);
  });
  it('a fully repaid loan cannot take another payment', async () => {
    await expect(mk(loanRow({ balance: 0 })).svc.recordLoanRepayment(dto())).rejects.toThrow(/already fully repaid/);
  });
  it('the loan row is locked (FOR UPDATE) before the balance is read, so two payments cannot both read the same balance', async () => {
    const t = mk(); await t.svc.recordLoanRepayment(explicit()).catch(() => undefined);
    expect(t.qr.query.mock.calls[0][0]).toMatch(/FOR UPDATE/i);
  });
  it('a failure rolls everything back', async () => {
    const t = mk(loanRow(), (sql) => { if (/INSERT INTO loan_repayment_ledger/.test(sql)) throw new Error('boom'); return undefined; });
    await expect(t.svc.recordLoanRepayment(explicit())).rejects.toThrow('boom'); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
});

describe('loan/LoanRepaymentService.recordLoanRepayment explicit components (separate interest)', () => {
  it('writes one ledger row with the component total and reduces the balance by the principal only', async () => {
    const t = mk(); const r = await t.svc.recordLoanRepayment(explicit({ principalAmount: 1000, interestAmount: 150.5, penalAmount: 20 }));
    const ins = t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_repayment_ledger/.test(c[0]))[1];
    const upd = t.qr.query.mock.calls.find((c: any[]) => /UPDATE loan_master SET balance = \$1/.test(c[0]))[1];
    expect(r.success).toBe(true); expect(ins[6]).toBe(1170.5); expect(ins[7]).toBe(1000); expect(ins[8]).toBe(150.5); expect(ins[9]).toBe(20); expect(upd[0]).toBe(59000);
    expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('components totalling zero are refused', async () => {
    await expect(mk().svc.recordLoanRepayment(explicit({ principalAmount: 0, interestAmount: 0, penalAmount: 0 }))).rejects.toThrow(/must total more than zero/);
  });
  it('negative components are treated as zero, never as a credit', async () => {
    await expect(mk().svc.recordLoanRepayment(explicit({ principalAmount: -500, interestAmount: 0, penalAmount: 0 }))).rejects.toThrow(/must total more than zero/);
  });
  it('principal above the outstanding balance is refused instead of silently discarding the excess', async () => {
    const t = mk(); await expect(t.svc.recordLoanRepayment(explicit({ principalAmount: 1e12 }))).rejects.toThrow(BadRequestException);
    expect(t.qr.query.mock.calls.some((c: any[]) => /INSERT INTO loan_repayment_ledger/.test(c[0]))).toBe(false);
  });
  it('the ledger row records exactly what is deducted from the balance (principal 70000 on a 60000 balance is not accepted)', async () => {
    const t = mk(); await t.svc.recordLoanRepayment(explicit({ principalAmount: 70000 })).catch(() => undefined);
    const ins = t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_repayment_ledger/.test(c[0]));
    expect(ins).toBeUndefined();
  });
  it('amounts are rounded to paise', async () => {
    const t = mk(); await t.svc.recordLoanRepayment(explicit({ principalAmount: 100.005, interestAmount: 0.1, penalAmount: 0.2 }));
    const ins = t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_repayment_ledger/.test(c[0]))[1];
    expect(ins[6]).toBe(Math.round((ins[7] + ins[8] + ins[9]) * 100) / 100);
  });
  it('a payroll-lag credit reduces the loan_master balance by the principal but is flagged in the ledger', async () => {
    const t = mk(); await t.svc.recordLoanRepayment(explicit({ isPayrollLagCredit: true, principalAmount: 500, interestAmount: 0 }));
    const ins = t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_repayment_ledger/.test(c[0]))[1];
    expect(ins[13]).toBe(true); expect(t.qr.query.mock.calls.some((c: any[]) => /GREATEST\(0, COALESCE\(balance, 0\) - \$1\)/.test(c[0]))).toBe(true);
  });
  it('a DEMAND source is recorded as DEMAND, anything else as CASH', async () => {
    const a = mk(); await a.svc.recordLoanRepayment(explicit({ source: 'DEMAND' }));
    expect(a.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_repayment_ledger/.test(c[0]))[1][14]).toBe('DEMAND');
    const b = mk(); await b.svc.recordLoanRepayment(explicit());
    expect(b.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_repayment_ledger/.test(c[0]))[1][14]).toBe('CASH');
  });
  it('the balance never goes below zero', async () => {
    const t = mk(loanRow({ balance: 500 })); await t.svc.recordLoanRepayment(explicit({ principalAmount: 500, interestAmount: 0 }));
    expect(t.qr.query.mock.calls.find((c: any[]) => /UPDATE loan_master SET balance = \$1/.test(c[0]))[1][0]).toBe(0);
  });
});

describe('loan/LoanRepaymentService.executeEarlyClosure guards', () => {
  const closure = (t: any, o: any = {}) => t.svc.executeEarlyClosure('77', undefined, o.adjustment ?? 0, 'u', undefined, true, o.mbno);
  it('unknown case: 400 and rollback', async () => {
    const t = mk(null); await expect(closure(t)).rejects.toThrow(/not found in loan_master/); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
  it('an already repaid loan cannot be closed again', async () => {
    await expect(closure(mk(loanRow({ balance: 0 })))).rejects.toThrow(/already fully repaid/);
  });
  it('an open re-agreement blocks the closure', async () => {
    const t = mk(loanRow(), (sql) => (/FROM loan_reagreements/.test(sql) ? [{ reagreement_no: 'RA1', status: 'APPLIED' }] : undefined));
    await expect(closure(t)).rejects.toThrow(/open re-agreement/);
  });
  it('a huge negative adjustment is refused (it would close the loan for almost nothing)', async () => {
    const t = mk(); const err = await closure(t, { adjustment: -999_999_999 }).catch((e: any) => e);
    expect(err?.status).toBe(400); expect(String(err?.message)).toMatch(/adjustment/i);
  });
  it('a non numeric adjustment is refused', async () => {
    const t = mk(); const err = await closure(t, { adjustment: 'abc' }).catch((e: any) => e); expect(err?.status).toBe(400); expect(String(err?.message)).toMatch(/adjustment/i);
  });
  it('the loan row is locked while the closure is computed and posted', async () => {
    const t = mk(); await closure(t).catch(() => undefined);
    expect(t.qr.query.mock.calls[0][0]).toMatch(/FOR UPDATE/i);
  });
  it('with a member number the lookup is restricted to that member', async () => {
    const t = mk(null); await closure(t, { mbno: '5' }).catch(() => undefined);
    expect(t.qr.query.mock.calls[0][0]).toContain('AND mbno = $2'); expect(t.qr.query.mock.calls[0][1]).toEqual(['77', '5']);
  });
});
