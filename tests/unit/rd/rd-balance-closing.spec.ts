import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RdBalanceEventsService } from '../../../src/modules/rd/services/rd-balance-events.service';
import { RdFinancialYearClosingService } from '../../../src/modules/rd/services/rd-financial-year-closing.service';

describe('rd/RdBalanceEventsService.recordWithdrawal', () => {
  function mk(o: { closed?: any[]; member?: any[]; pot?: number | null; installments?: any[]; holdings?: number; locked?: number; min?: number } = {}) {
    const calls: any[] = [];
    const run = jest.fn(async (sql: string, p?: any[]) => {
      calls.push([sql, p]);
      if (/FROM rd_financial_year_summary/.test(sql)) return o.closed ?? [];
      if (/FROM member_master/.test(sql)) return o.member ?? [{ mbno: 5 }];
      if (/SELECT resulting_balance FROM rd_balance_events/.test(sql)) return o.pot === null || o.pot === undefined ? [] : [{ resulting_balance: o.pot }];
      if (/FROM rd_installment_ledger/.test(sql)) return o.installments ?? [];
      if (/SUM\(lien_amount\)/.test(sql)) return [{ total: o.locked ?? 0 }];
      return [];
    });
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
    const ds: any = { query: run, createQueryRunner: jest.fn(() => qr) };
    const rules: any = { getRule: jest.fn().mockResolvedValue(o.min ?? 1000) };
    const svc: any = new RdBalanceEventsService(ds, rules);
    svc.getTotalCurrentHoldings = jest.fn().mockResolvedValue(o.holdings ?? 50000);
    return { svc: svc as RdBalanceEventsService, qr, calls };
  }
  const wd = (t: any, amt: number) => t.svc.recordWithdrawal('5', 3, amt, new Date(2026, 5, 1), 'bob', 'n');

  it('rejects 0, negative and NaN amounts', async () => { for (const a of [0, -5, NaN]) await expect(wd(mk(), a)).rejects.toThrow(BadRequestException); });
  it('rejects an absurd amount', async () => { await expect(wd(mk(), 1e12)).rejects.toThrow(/below the required minimum/); });
  it('a closed RD year refuses withdrawals; unknown member 404', async () => {
    await expect(wd(mk({ closed: [{ closed_at: new Date() }] }), 100)).rejects.toThrow(/already closed/);
    await expect(wd(mk({ member: [] }), 100)).rejects.toThrow(NotFoundException);
  });
  it('the minimum balance must stay: holdings 5000, minimum 1000, so 4000 is the maximum', async () => {
    await expect(wd(mk({ holdings: 5000 }), 4001)).rejects.toThrow(/Maximum withdrawable right now: ₹4,000/);
    await expect(wd(mk({ holdings: 5000, pot: 5000 }), 4000)).resolves.toBeDefined();
  });
  it('RD locked for a Loan Against RD cannot be withdrawn', async () => {
    await expect(wd(mk({ holdings: 10000, locked: 8000 }), 1500)).rejects.toThrow(/locked as security/);
  });
  it('takes from the opening pot first, then from instalments oldest first', async () => {
    const t = mk({ holdings: 20000, pot: 3000, installments: [{ id: 1, paid_amount: '2000', withdrawn_amount: '500' }, { id: 2, paid_amount: '2000', withdrawn_amount: '0' }] });
    const r = await wd(t, 5000);
    expect(r).toMatchObject({ fromOpeningPot: 3000, fromInstallments: 2000, remainingTotalHoldings: 15000 });
    const upd = t.calls.filter((c) => /UPDATE rd_installment_ledger/.test(c[0])); expect(upd[0][1][0]).toBe(1500); expect(upd[1][1][0]).toBe(500);
  });
  it('locks the member balance (advisory lock) and the instalment rows (FOR UPDATE)', async () => {
    const t = mk({ holdings: 20000, pot: 0, installments: [{ id: 1, paid_amount: '5000', withdrawn_amount: '0' }] }); await wd(t, 1000);
    expect(t.calls.some((c) => /pg_advisory_xact_lock/.test(c[0]))).toBe(true); expect(t.calls.some((c) => /FOR UPDATE/.test(c[0]))).toBe(true);
  });
  it('if the two pots cannot supply the amount the withdrawal is cancelled and rolled back', async () => {
    const t = mk({ holdings: 20000, pot: 0, installments: [{ id: 1, paid_amount: '500', withdrawn_amount: '0' }] });
    await expect(wd(t, 1000)).rejects.toThrow(/Could only find/); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.commitTransaction).not.toHaveBeenCalled();
  });
  it('commits and releases on success', async () => {
    const t = mk({ holdings: 20000, pot: 5000 }); await wd(t, 1000); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1); expect(t.qr.release).toHaveBeenCalled();
  });
});

describe('rd/RdBalanceEventsService.appendEvent via opening balance', () => {
  it('new balance = latest balance + delta, rounded to paise, stored with the absolute amount', async () => {
    const calls: any[] = [];
    const run = jest.fn(async (sql: string, p?: any[]) => { calls.push([sql, p]); return /SELECT resulting_balance/.test(sql) ? [{ resulting_balance: '1000.10' }] : []; });
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
    const svc = new RdBalanceEventsService({ createQueryRunner: () => qr, query: run } as any, {} as any);
    expect(await svc.recordOpeningBalance('5', 3, 250.2, new Date(2026, 3, 1), 'u')).toBe(1250.3);
    expect(calls.find((c) => /INSERT INTO rd_balance_events/.test(c[0]))[1].slice(2, 6)).toEqual(['2026-04-01', 'OPENING', 250.2, 1250.3]);
  });
  it('an opening balance of zero or negative is refused', async () => {
    const run = jest.fn().mockResolvedValue([]);
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
    const svc = new RdBalanceEventsService({ createQueryRunner: () => qr, query: run } as any, {} as any);
    for (const a of [-100, NaN]) await expect(svc.recordOpeningBalance('5', 3, a, new Date(), 'u')).rejects.toThrow(BadRequestException);
  });
});

describe('rd/RdFinancialYearClosingService', () => {
  const eval0 = { totalDue: 12, totalPaidOnTime: 12, totalPaidLate: 0, totalStillMissing: 0, autoEligibleFullInterest: true, detectedPattern: 'FULLY_REGULAR' };
  function mk(o: { closed?: any[]; fy?: any[]; next?: any[]; rolled?: any[]; inst?: number; open?: number; closing?: number; instMoney?: number; pattern?: any } = {}) {
    const calls: any[] = [];
    const run = jest.fn(async (sql: string, p?: any[]) => {
      calls.push([sql, p]);
      if (/closed_at FROM rd_financial_year_summary/.test(sql)) return o.closed ?? [];
      if (/SELECT end_date FROM yearend/.test(sql)) return o.fy ?? [{ end_date: '2027-03-31' }];
      if (/event_type = 'OPENING' ORDER BY event_date ASC/.test(sql)) return [];
      if (/SELECT resulting_balance FROM rd_balance_events/.test(sql)) return [{ resulting_balance: o.closing ?? 11000 }];
      if (/SUM\(paid_amount - withdrawn_amount\)/.test(sql)) return [{ total: o.instMoney ?? 0 }];
      if (/FROM yearend WHERE start_date >/.test(sql)) return o.next ?? [{ yearcode: 4, start_date: '2027-04-01' }];
      if (/event_type = 'OPENING' LIMIT 1/.test(sql)) return o.rolled ?? [];
      return [];
    });
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
    const ds: any = { query: run, createQueryRunner: jest.fn(() => qr) };
    const rules: any = { getRule: jest.fn().mockResolvedValue(7) };
    const cfg: any = { getCurrentAmount: jest.fn().mockResolvedValue(500) };
    const ev: any = { recordInterestCredit: jest.fn().mockResolvedValue(0), recordOpeningBalance: jest.fn().mockResolvedValue(0), getCurrentBalance: jest.fn().mockResolvedValue(0) };
    const pat: any = { evaluateMember: jest.fn().mockResolvedValue(o.pattern ?? eval0) };
    const ic: any = { calculateInstallmentInterest: jest.fn().mockResolvedValue({ totalInterest: o.inst ?? 780 }), calculateOpeningBalanceInterest: jest.fn().mockResolvedValue({ totalInterest: o.open ?? 700 }), previewTotalInterest: jest.fn() };
    return { svc: new RdFinancialYearClosingService(ds, rules, cfg, ev, pat, ic), qr, calls, ev, ic };
  }
  it('an already closed member year cannot be closed again', async () => { await expect(mk({ closed: [{ closed_at: 'x' }] }).svc.closeMemberYear('5', 3, 'u')).rejects.toThrow(/already closed/); });
  it('an unknown year: 404', async () => { await expect(mk({ fy: [] }).svc.closeMemberYear('5', 3, 'u')).rejects.toThrow(NotFoundException); });
  it('credits both interests, writes the summary, rolls the closing balance into the next year', async () => {
    const t = mk(); const r = await t.svc.closeMemberYear('5', 3, 'bob');
    expect(t.ev.recordInterestCredit).toHaveBeenCalledTimes(2); expect(r).toMatchObject({ totalInterestCredited: 1480, closingBalance: 11000, nextYearcode: 4, rolledForward: true, finalEligibleFullInterest: true });
    expect(t.ev.recordOpeningBalance.mock.calls[0][2]).toBe(11000); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('closing balance = last balance event + instalment money not yet withdrawn', async () => {
    expect((await mk({ closing: 1000, instMoney: 6000 }).svc.closeMemberYear('5', 3, 'u')).closingBalance).toBe(7000);
  });
  it('zero interest means no credit event', async () => {
    const t = mk({ inst: 0, open: 0 }); await t.svc.closeMemberYear('5', 3, 'u'); expect(t.ev.recordInterestCredit).not.toHaveBeenCalled();
  });
  it('a next year that already has an opening balance is not overwritten', async () => {
    const t = mk({ rolled: [{ id: 1 }] }); const r = await t.svc.closeMemberYear('5', 3, 'u');
    expect(t.ev.recordOpeningBalance).not.toHaveBeenCalled(); expect(r.rolledForward).toBe(false); expect(r.rolloverNote).toMatch(/already has an opening balance/);
  });
  it('without a next year the balance is not rolled and the user is told', async () => {
    const r = await mk({ next: [] }).svc.closeMemberYear('5', 3, 'u'); expect(r).toMatchObject({ nextYearcode: null, rolledForward: false }); expect(r.rolloverNote).toMatch(/NOT rolled forward/);
  });
  it('an authority override replaces the automatic eligibility and is recorded', async () => {
    const t = mk({ pattern: { ...eval0, autoEligibleFullInterest: false } }); const r = await t.svc.closeMemberYear('5', 3, 'u', { eligible: true, reason: 'board decision', by: 'mgr' });
    expect(t.ic.calculateInstallmentInterest.mock.calls[0][2]).toBe(true); expect(r).toMatchObject({ authorityOverride: true, authorityOverrideReason: 'board decision', autoEligibleFullInterest: false });
  });
  it('an override without a reason is refused', async () => {
    await expect(mk().svc.closeMemberYear('5', 3, 'u', { eligible: true, reason: '', by: 'mgr' })).rejects.toThrow(BadRequestException);
  });
  it('a failure rolls the whole member closing back', async () => {
    const t = mk(); t.ev.recordInterestCredit.mockRejectedValue(new Error('x')); await expect(t.svc.closeMemberYear('5', 3, 'u')).rejects.toThrow('x');
    expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('two simultaneous closings of the same member cannot both credit the interest (lock inside the transaction)', async () => {
    const t = mk(); await t.svc.closeMemberYear('5', 3, 'u');
    expect(t.calls.some((c) => /pg_advisory_xact_lock|FOR UPDATE/.test(c[0]))).toBe(true);
  });
  it('closeFinancialYear continues after one member fails and reports each result', async () => {
    const t = mk(); (t.svc as any).listMembersWithActivity = jest.fn().mockResolvedValue(['1', '2']);
    (t.svc as any).closeMemberYear = jest.fn().mockResolvedValueOnce({ mbno: '1' }).mockRejectedValueOnce(new Error('bad'));
    jest.spyOn((t.svc as any).logger, 'warn').mockImplementation(() => undefined);
    expect(await t.svc.closeFinancialYear(3, 'u')).toEqual({ succeeded: [{ mbno: '1' }], failed: [{ mbno: '2', error: 'bad' }] });
  });
  it('preview paging returns the total and the requested slice', async () => {
    const t = mk(); (t.svc as any).listMembersWithActivity = jest.fn().mockResolvedValue(['1', '2', '3']); (t.svc as any).previewMemberClosing = jest.fn(async (m: string) => ({ mbno: m }));
    expect(await t.svc.previewFinancialYearClosing(3, 2, 1)).toEqual({ total: 3, members: [{ mbno: '2' }, { mbno: '3' }] });
  });
});
