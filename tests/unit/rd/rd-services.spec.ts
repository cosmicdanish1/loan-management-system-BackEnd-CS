import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RdLienService } from '../../../src/modules/rd/services/rd-lien.service';
import { RdMemberConfigService } from '../../../src/modules/rd/services/rd-member-config.service';
import { RdRepaymentService } from '../../../src/modules/rd/services/rd-repayment.service';
import { RdInterestCalculationService } from '../../../src/modules/rd/services/rd-interest-calculation.service';
import { RdRulesService } from '../../../src/modules/rd/rd-rules.service';
import { RD_RULE_DEFAULTS } from '../../../src/modules/rd/rd-business-rules';

describe('rd/RdRulesService', () => {
  const mk = (rows: any[] | Error) => new RdRulesService({ query: jest.fn(async () => { if (rows instanceof Error) throw rows; return rows; }) } as any);
  beforeEach(() => jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());
  it('returns the stored number', async () => expect(await mk([{ value: '350' }]).getRule('RULE_RD_MIN_MONTHLY_AMOUNT')).toBe(350));
  it('missing, empty or null value falls back to the default', async () => {
    for (const rows of [[], [{ value: '' }], [{ value: null }]]) expect(await mk(rows).getRule('RULE_RD_MIN_MONTHLY_AMOUNT')).toBe(200);
  });
  it('a non numeric number rule falls back to the default', async () => expect(await mk([{ value: 'abc' }]).getRule('RULE_RD_OPENING_BALANCE_RATE')).toBe(7));
  it('boolean rules accept true / 1 / Y and nothing else', async () => {
    for (const v of ['true', '1', 'Y']) expect(await mk([{ value: v }]).getRule('RULE_RD_ALLOW_MULTIPLE_GAPS')).toBe(true);
    for (const v of ['false', '0', 'N', 'yes']) expect(await mk([{ value: v }]).getRule('RULE_RD_ALLOW_MULTIPLE_GAPS')).toBe(false);
  });
  it('a database error falls back to the default', async () => expect(await mk(new Error('down')).getRule('RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL')).toBe(1000));
  it('getAllRules returns every rule', async () => expect(Object.keys(await mk([]).getAllRules()).sort()).toEqual(Object.keys(RD_RULE_DEFAULTS).sort()));
});

describe('rd/RdMemberConfigService.setMonthlyAmount', () => {
  const mk = (over: { member?: any[]; year?: any[]; min?: number } = {}) => {
    const ds: any = { query: jest.fn(async (sql: string) => (/FROM member_master/.test(sql) ? over.member ?? [{ mbno: 5 }] : /FROM yearend/.test(sql) ? over.year ?? [{ yearcode: 3 }] : [])) };
    const rules: any = { getRule: jest.fn().mockResolvedValue(over.min ?? 200) };
    return { svc: new RdMemberConfigService(ds, rules), ds };
  };
  it('unknown member: 404', async () => { await expect(mk({ member: [] }).svc.setMonthlyAmount('5', 3, 500, 'u')).rejects.toThrow(NotFoundException); });
  it('below the configured minimum: 400', async () => { await expect(mk().svc.setMonthlyAmount('5', 3, 199, 'u')).rejects.toThrow(/at least ₹200/); });
  it('exactly the minimum is allowed', async () => { await expect(mk().svc.setMonthlyAmount('5', 3, 200, 'u')).resolves.toBeUndefined(); });
  it('unknown financial year: 400', async () => { await expect(mk({ year: [] }).svc.setMonthlyAmount('5', 3, 500, 'u')).rejects.toThrow(/does not exist/); });
  it('inserts a new history row (older amounts are kept) with the effective date or today', async () => {
    const t = mk(); await t.svc.setMonthlyAmount('5', 3, 500, 'bob', new Date('2026-06-01'));
    const ins = t.ds.query.mock.calls.find((c: any[]) => /INSERT INTO rd_member_config/.test(c[0])); expect(ins[1]).toEqual(['5', 3, 500, new Date('2026-06-01'), 'bob']);
  });
  it('a non numeric amount is refused (NaN < minimum is false)', async () => { await expect(mk().svc.setMonthlyAmount('5', 3, NaN, 'u')).rejects.toThrow(BadRequestException); });
  it('an absurd amount (1e12) is refused', async () => { await expect(mk().svc.setMonthlyAmount('5', 3, 1e12, 'u')).rejects.toThrow(BadRequestException); });
  it('getCurrentAmount: latest effective row, 0 when none', async () => {
    const ds: any = { query: jest.fn().mockResolvedValueOnce([{ monthly_rd_amount: '750' }]).mockResolvedValueOnce([]) };
    const svc = new RdMemberConfigService(ds, {} as any); expect(await svc.getCurrentAmount('5', 3)).toBe(750); expect(await svc.getCurrentAmount('5', 3)).toBe(0);
  });
  it('getHistory maps the rows oldest first', async () => {
    const ds: any = { query: jest.fn().mockResolvedValue([{ id: 1, monthly_rd_amount: '500', effective_from_date: 'd', set_by: 'u', created_at: 'c' }]) };
    expect(await new RdMemberConfigService(ds, {} as any).getHistory('5', 3)).toEqual([{ id: 1, monthlyRdAmount: 500, effectiveFromDate: 'd', setBy: 'u', createdAt: 'c' }]);
  });
});

describe('rd/RdLienService', () => {
  function mk(o: { year?: any[]; existing?: any[]; holdings?: number; min?: number; locked?: number } = {}) {
    const calls: any[] = [];
    const run = jest.fn(async (sql: string, p?: any[]) => {
      calls.push([sql, p]);
      if (/FROM yearend/.test(sql)) return o.year ?? [{ yearcode: 3 }];
      if (/SELECT id, lien_amount FROM rd_lien/.test(sql)) return o.existing ?? [];
      if (/SUM\(lien_amount\)/.test(sql)) return [{ total: o.locked ?? 0 }];
      if (/INSERT INTO rd_lien/.test(sql)) return [{ id: 9 }];
      return [];
    });
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
    const ds: any = { createQueryRunner: jest.fn(() => qr), query: run };
    const ev: any = { getTotalCurrentHoldings: jest.fn().mockResolvedValue(o.holdings ?? 100000) };
    const rules: any = { getRule: jest.fn().mockResolvedValue(o.min ?? 1000) };
    return { svc: new RdLienService(ds, ev, rules), qr, calls };
  }
  const p = (amount: number, o: any = {}) => ({ mbno: '5', loanCaseNo: '77', amount, placedBy: 'u', ...o });
  it('amount must be greater than zero (0, negative, NaN)', async () => { for (const a of [0, -5, NaN]) await expect(mk().svc.place(p(a))).rejects.toThrow(/greater than zero/); });
  it('no current financial year: 400 and rollback', async () => {
    const t = mk({ year: [] }); await expect(t.svc.place(p(1000))).rejects.toThrow(/No current financial year/); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('locks up to holdings - already locked - minimum balance', async () => {
    const t = mk({ holdings: 100000, locked: 20000, min: 1000 });
    await expect(t.svc.place(p(79001))).rejects.toThrow(/At most ₹79,000 can be locked/); await expect(mk({ holdings: 100000, locked: 20000, min: 1000 }).svc.place(p(79000))).resolves.toMatchObject({ lienAmount: 79000, alreadyLocked: false });
  });
  it('takes advisory locks (member lien, member balance) before checking', async () => {
    const t = mk(); await t.svc.place(p(1000));
    expect(t.calls.filter((c) => /pg_advisory_xact_lock/.test(c[0]))).toHaveLength(2);
  });
  it('the same case with the same amount is a no-op (alreadyLocked), a different amount is refused', async () => {
    expect(await mk({ existing: [{ id: 4, lien_amount: '5000' }] }).svc.place(p(5000))).toEqual({ id: 4, lienAmount: 5000, alreadyLocked: true });
    await expect(mk({ existing: [{ id: 4, lien_amount: '5000' }] }).svc.place(p(6000))).rejects.toThrow(/already has ₹5,000/);
  });
  it('amounts are rounded to paise and commit once', async () => {
    const t = mk(); await t.svc.place(p(1000.456)); expect(t.calls.find((c) => /INSERT INTO rd_lien/.test(c[0]))[1][2]).toBe(1000.46); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('with an outer transaction it neither commits nor releases', async () => {
    const t = mk(); const outer: any = { query: t.qr.query, commitTransaction: jest.fn(), release: jest.fn(), rollbackTransaction: jest.fn() };
    await t.svc.place(p(1000), outer); expect(outer.commitTransaction).not.toHaveBeenCalled(); expect(outer.release).not.toHaveBeenCalled();
  });
  it('release sums what it released, accepting both [rows] and [[rows], n] shapes', async () => {
    const a = new RdLienService({ query: jest.fn().mockResolvedValue([{ lien_amount: '100' }, { lien_amount: '50.5' }]) } as any, {} as any, {} as any);
    expect(await a.release('77', 'u', 'closed')).toBe(150.5);
    const b = new RdLienService({ query: jest.fn().mockResolvedValue([[{ lien_amount: '70' }], 1]) } as any, {} as any, {} as any);
    expect(await b.release('77', 'u', 'closed')).toBe(70);
  });
  it('release cuts user and reason to the column sizes', async () => {
    const q = jest.fn().mockResolvedValue([]); await new RdLienService({ query: q } as any, {} as any, {} as any).release('77', 'u'.repeat(80), 'r'.repeat(300));
    expect(q.mock.calls[0][1][1]).toHaveLength(50); expect(q.mock.calls[0][1][2]).toHaveLength(100);
  });
  it('transfer: false when the old case has no active lien, otherwise release + place', async () => {
    const t = mk(); const qr: any = { query: jest.fn(async (sql: string) => (/SELECT 1 FROM rd_lien/.test(sql) ? [] : [])) };
    expect(await t.svc.transfer({ mbno: '5', oldCaseNo: '1', newCaseNo: '2', amount: 100, by: 'u' }, qr)).toBe(false);
  });
  it('getLockedAmount sums the active liens', async () => { expect(await mk({ locked: 1234.5 }).svc.getLockedAmount('5')).toBe(1234.5); });
});

describe('rd/RdRepaymentService', () => {
  const fy = { start_date: '2026-04-01', end_date: '2027-03-31' };
  function mk(o: { fy?: any[]; existing?: any[]; config?: any[]; closed?: any[]; member?: any[] } = {}) {
    const ds: any = {
      query: jest.fn(async (sql: string) => {
        if (/FROM yearend/.test(sql)) return o.fy ?? [fy];
        if (/FROM rd_installment_ledger/.test(sql)) return o.existing ?? [];
        if (/FROM rd_member_config/.test(sql)) return o.config ?? [];
        if (/FROM rd_financial_year_summary/.test(sql)) return o.closed ?? [];
        if (/FROM member_master/.test(sql)) return o.member ?? [{ mbno: 5 }];
        return [];
      }),
    };
    return { svc: new RdRepaymentService(ds), ds };
  }
  it('pending: unknown year 404; 12 months from April, due on the 5th', async () => {
    await expect(mk({ fy: [] }).svc.getPendingInstallments('5', 3)).rejects.toThrow(NotFoundException);
    const r = await mk({ config: [{ monthly_rd_amount: '500', effective_from_date: '2026-01-01' }] }).svc.getPendingInstallments('5', 3);
    expect(r).toHaveLength(12); expect(r[0]).toMatchObject({ installmentMonth: 4, installmentYear: 2026, dueDate: '2026-04-05', expectedAmount: 500, status: 'UNPAID' }); expect(r[11]).toMatchObject({ installmentMonth: 3, installmentYear: 2027 });
  });
  it('pending: the amount changes from the month the new configuration takes effect', async () => {
    const r = await mk({ config: [{ monthly_rd_amount: '500', effective_from_date: '2026-01-01' }, { monthly_rd_amount: '800', effective_from_date: '2026-09-01' }] }).svc.getPendingInstallments('5', 3);
    expect(r.map((x) => x.expectedAmount)).toEqual([500, 500, 500, 500, 500, 800, 800, 800, 800, 800, 800, 800]);
  });
  it('pending: paid, partial and unpaid statuses come from the ledger', async () => {
    const r = await mk({ existing: [{ installment_month: 4, installment_year: 2026, due_date: 'd', expected_amount: '500', paid_amount: '500', paid_date: 'p' }, { installment_month: 5, installment_year: 2026, due_date: 'd', expected_amount: '500', paid_amount: '200', paid_date: 'p' }] }).svc.getPendingInstallments('5', 3);
    expect(r.slice(0, 3).map((x) => x.status)).toEqual(['PAID', 'PARTIAL', 'UNPAID']);
  });
  const pay = (t: any, a: number, m = 4, y = 2026, paid = new Date(2026, 3, 10)) => t.svc.recordPayment('5', 3, m, y, a, paid, undefined, 'bob');
  it('rejects 0 and negative amounts', async () => { for (const a of [0, -5]) await expect(pay(mk(), a)).rejects.toThrow(/greater than zero/); });
  it('rejects a non numeric amount (NaN)', async () => { await expect(pay(mk(), NaN)).rejects.toThrow(BadRequestException); });
  it('rejects an absurd amount (1e12) and an amount far above the instalment (70,000 on 700)', async () => {
    await expect(pay(mk({ config: [{ monthly_rd_amount: '700' }] }), 1e12)).rejects.toThrow(BadRequestException);
    await expect(pay(mk({ config: [{ monthly_rd_amount: '700' }] }), 70000)).rejects.toThrow(BadRequestException);
  });
  it('rejects an impossible month or year (13, 0, 1900)', async () => {
    for (const [m, y] of [[13, 2026], [0, 2026], [4, 1900]]) await expect(pay(mk(), 500, m, y)).rejects.toThrow(BadRequestException);
  });
  it('rejects a month outside the financial year', async () => { await expect(pay(mk(), 500, 4, 2030)).rejects.toThrow(BadRequestException); });
  it('a closed RD year refuses payments; unknown member 404', async () => {
    await expect(pay(mk({ closed: [{ closed_at: new Date() }] }), 500)).rejects.toThrow(/already closed/);
    await expect(pay(mk({ member: [] }), 500)).rejects.toThrow(NotFoundException);
  });
  it('records the payment, expected amount from the configuration, due on the 5th', async () => {
    const t = mk({ config: [{ monthly_rd_amount: '700' }] }); const r = await pay(t, 700);
    expect(r).toMatchObject({ dueDate: '2026-04-05', expectedAmount: 700, paidAmount: 700, status: 'PAID' });
  });
  it('a smaller payment is PARTIAL', async () => { expect((await pay(mk({ config: [{ monthly_rd_amount: '700' }] }), 300)).status).toBe('PARTIAL'); });
  it('a payment in a later month is flagged as arrear clearance, same month is not', async () => {
    const late = mk(); await pay(late, 500, 4, 2026, new Date(2026, 5, 3));
    expect(late.ds.query.mock.calls.find((c: any[]) => /INSERT INTO rd_installment_ledger/.test(c[0]))[1][8]).toBe(true);
    const ok = mk(); await pay(ok, 500, 4, 2026, new Date(2026, 3, 20));
    expect(ok.ds.query.mock.calls.find((c: any[]) => /INSERT INTO rd_installment_ledger/.test(c[0]))[1][8]).toBe(false);
  });
});

describe('rd/RdInterestCalculationService', () => {
  const mk = (o: { fy?: any[]; paid?: any[]; events?: any[]; auto?: boolean; rate?: number } = {}) => {
    const ds: any = { query: jest.fn(async (sql: string) => (/FROM yearend/.test(sql) ? o.fy ?? [{ end_date: '2027-03-31' }] : /FROM rd_installment_ledger/.test(sql) ? o.paid ?? [] : /FROM rd_balance_events/.test(sql) ? o.events ?? [] : [])) };
    const rules: any = { getRule: jest.fn().mockResolvedValue(o.rate ?? 12) };
    const pat: any = { evaluateMember: jest.fn().mockResolvedValue({ autoEligibleFullInterest: o.auto ?? true }) };
    return { svc: new RdInterestCalculationService(ds, rules, pat), pat };
  };
  it('unknown financial year: 404', async () => { await expect(mk({ fy: [] }).svc.getFinancialYearEndDate(3)).rejects.toThrow(NotFoundException); });
  it('only fully paid installments earn interest, using the pattern eligibility', async () => {
    const t = mk({ paid: [{ due_date: '2026-04-01', paid_date: '2026-06-10', paid_amount: '1000' }] });
    expect((await t.svc.calculateInstallmentInterest('5', 3)).totalInterest).toBe(120);
    expect((await mk({ paid: [{ due_date: '2026-04-01', paid_date: '2026-06-10', paid_amount: '1000' }], auto: false }).svc.calculateInstallmentInterest('5', 3)).totalInterest).toBe(100);
  });
  it('an explicit override beats the automatic pattern result', async () => {
    const t = mk({ paid: [{ due_date: '2026-04-01', paid_date: '2026-06-10', paid_amount: '1000' }], auto: false });
    expect((await t.svc.calculateInstallmentInterest('5', 3, true)).totalInterest).toBe(120);
  });
  it('opening balance interest comes from the balance events', async () => {
    const t = mk({ events: [{ event_date: '2026-04-01', event_type: 'OPENING', resulting_balance: '10000' }] });
    expect((await t.svc.calculateOpeningBalanceInterest('5', 3)).totalInterest).toBe(1200);
  });
  it('preview = installment interest + opening balance interest, rounded to paise', async () => {
    const t = mk({ paid: [{ due_date: '2026-04-01', paid_date: '2026-04-05', paid_amount: '333' }], events: [{ event_date: '2026-04-01', event_type: 'OPENING', resulting_balance: '1001' }] });
    const r = await t.svc.previewTotalInterest('5', 3); expect(r.totalInterest).toBe(Math.round((r.installmentInterest.totalInterest + r.openingBalanceInterest.totalInterest) * 100) / 100); expect(r.fullInterestEligible).toBe(true);
  });
});
