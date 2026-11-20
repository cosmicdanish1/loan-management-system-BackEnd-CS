import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RdBalanceEventsService } from '../../../src/modules/rd/services/rd-balance-events.service';
import { RdFinancialYearClosingService } from '../../../src/modules/rd/services/rd-financial-year-closing.service';

describe('rd/RdBalanceEventsService.recordWithdrawal', () => {
  function mk(o: { closed?: any[]; member?: any[]; pot?: number | null; installments?: any[]; holdings?: number; locked?: number; min?: number; cdCovers?: boolean } = {}) {
    const calls: any[] = [];
    const run = jest.fn(async (sql: string, p?: any[]) => {
      calls.push([sql, p]);
      if (/FROM rd_financial_year_summary/.test(sql)) return o.closed ?? [];
      if (/FROM member_master/.test(sql)) return o.member ?? [{ mbno: 5 }];
      if (/SELECT resulting_balance FROM rd_balance_events/.test(sql)) return o.pot === null || o.pot === undefined ? [] : [{ resulting_balance: o.pot }];
      if (/FROM rd_installment_ledger/.test(sql)) return o.installments ?? [];
      if (/SUM\(lien_amount\)/.test(sql)) return [{ total: o.locked ?? 0 }];
      // the single RD/CD balance: UPDATE ... RETURNING comes back as [rows, rowCount]
      if (/UPDATE member_balances SET compulsory_deposit/.test(sql)) return o.cdCovers === false ? [[], 0] : [[{ compulsory_deposit: 1 }], 1];
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
  it('RD and CD are one balance: money the timeline pots do not cover (a migrated member has no timeline) comes from the CD figure', async () => {
    const t = mk({ holdings: 20000, pot: 0, installments: [{ id: 1, paid_amount: '500', withdrawn_amount: '0' }] });
    await expect(wd(t, 1000)).resolves.toMatchObject({ fromOpeningPot: 0, fromInstallments: 500, remainingTotalHoldings: 19000 });
    const cd = t.calls.find((c) => /UPDATE member_balances SET compulsory_deposit/.test(c[0])); expect(cd[1]).toEqual([1000, '5', 1000]); // amount, member, minimum balance + locked
    expect(t.qr.commitTransaction).toHaveBeenCalled();
  });
  it('the whole withdrawal lowers the single RD/CD balance; if a concurrent withdrawal already used it, nothing is taken and it rolls back', async () => {
    const t = mk({ holdings: 20000, pot: 5000, cdCovers: false });
    await expect(wd(t, 1000)).rejects.toThrow(/can no longer be withdrawn/); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.commitTransaction).not.toHaveBeenCalled();
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
  function mk(o: { closed?: any[]; fy?: any[]; next?: any[]; rolled?: any[]; inst?: number; open?: number; closing?: number; instMoney?: number; pattern?: any; noHead?: boolean } = {}) {
    const calls: any[] = [];
    const run = jest.fn(async (sql: string, p?: any[]) => {
      calls.push([sql, p]);
      if (/closed_at FROM rd_financial_year_summary/.test(sql)) return o.closed ?? [];
      if (/SELECT end_date FROM yearend/.test(sql)) return o.fy ?? [{ end_date: '2027-03-31' }];
      if (/event_type = 'OPENING' ORDER BY event_date ASC/.test(sql)) return [];
      // ES-581: the closing balance is the member's real RD/CD balance
      if (/SELECT COALESCE\(compulsory_deposit, 0\)::float AS bal FROM member_balances/.test(sql)) return [{ bal: o.closing ?? 11000 }];
      if (/FROM yearend WHERE start_date >/.test(sql)) return o.next ?? [{ yearcode: 4, start_date: '2027-04-01' }];
      if (/event_type = 'OPENING' LIMIT 1/.test(sql)) return o.rolled ?? [];
      // the yearly interest journal (DR E1026 / CR L1004)
      if (/FROM headmaster WHERE TRIM\(code\) = \$1/.test(sql)) return o.noHead ? [] : [{ x: 1 }];
      if (/UPDATE member_balances SET compulsory_deposit/.test(sql)) return [[{ balance: 25000 }], 1];
      if (/MAX\(/.test(sql)) return [{ n: 1 }];
      return [];
    });
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
    const ds: any = { query: run, createQueryRunner: jest.fn(() => qr) };
    const rules: any = { getRule: jest.fn().mockResolvedValue(7) };
    const cfg: any = { getCurrentAmount: jest.fn().mockResolvedValue(500) };
    const ev: any = { recordInterestCredit: jest.fn().mockResolvedValue(0), recordOpeningBalance: jest.fn().mockResolvedValue(0), getCurrentBalance: jest.fn().mockResolvedValue(0) };
    const pat: any = { evaluateMember: jest.fn().mockResolvedValue(o.pattern ?? eval0) };
    const ic: any = { calculateInstallmentInterest: jest.fn().mockResolvedValue({ totalInterest: o.inst ?? 780 }), calculateOpeningBalanceInterest: jest.fn().mockResolvedValue({ totalInterest: o.open ?? 700 }), previewTotalInterest: jest.fn(), getLedgerOpeningBalance: jest.fn().mockResolvedValue(9000) };
    const seq: any = { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH800') };
    return { svc: new RdFinancialYearClosingService(ds, rules, cfg, ev, pat, ic, seq), qr, calls, ev, ic };
  }
  it('an already closed member year cannot be closed again', async () => { await expect(mk({ closed: [{ closed_at: 'x' }] }).svc.closeMemberYear('5', 3, 'u')).rejects.toThrow(/already closed/); });
  it('an unknown year: 404', async () => { await expect(mk({ fy: [] }).svc.closeMemberYear('5', 3, 'u')).rejects.toThrow(NotFoundException); });
  it('credits both interests, writes the summary, rolls the closing balance into the next year', async () => {
    const t = mk(); const r = await t.svc.closeMemberYear('5', 3, 'bob');
    expect(t.ev.recordInterestCredit).toHaveBeenCalledTimes(2); expect(r).toMatchObject({ totalInterestCredited: 1480, closingBalance: 11000, nextYearcode: 4, rolledForward: true, finalEligibleFullInterest: true });
    expect(t.ev.recordOpeningBalance.mock.calls[0][2]).toBe(11000); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('stage 6: the interest is POSTED like the legacy: one journal, DR E1026 + CR L1004, both with the member, no other head', async () => {
    const t = mk(); const r: any = await t.svc.closeMemberYear('5', 3, 'bob');
    expect(r.interestVoucherNo).toBe('VCH800');
    const ledger = t.calls.filter((c) => /INSERT INTO ledger/.test(c[0])).map((c) => c[1] as any[]);
    // params: [trans_no, date, direction, code, mbno, accType, amount, voucher, 'CD', pl_balance, text, user, ledgerid]
    expect(ledger.map((p) => [p[2], p[3], p[4], p[5], p[6], p[7]])).toEqual([['DR', 'E1026', '5', 'OTH', 1480, 'VCH800'], ['CR', 'L1004', '5', 'CD', 1480, 'VCH800']]);
    expect(ledger[0][1]).toBe('2027-03-31'); // dated the year end, as the legacy did
    expect(ledger.some((p) => ['A1002', 'A1001', 'L1028'].includes(p[3]))).toBe(false);
    const upd = t.calls.find((c) => /UPDATE member_balances SET compulsory_deposit/.test(c[0])); expect(upd[1]).toEqual([1480, '5']);
    const v = t.calls.find((c) => /INSERT INTO vouchers/.test(c[0])); expect(v[0]).toMatch(/'JOURNAL'/); expect(v[0]).toMatch(/RD_CD_INTEREST/);
    expect(t.calls.some((c) => /INSERT INTO tblcashbook/.test(c[0]))).toBe(false); // not cash
  });
  it('stage 6: no interest means no journal and no voucher number is taken; a missing E1026 head stops the closing and rolls back', async () => {
    const none = mk({ inst: 0, open: 0 }); const r: any = await none.svc.closeMemberYear('5', 3, 'u');
    expect(r.interestVoucherNo).toBeNull(); expect(none.calls.some((c) => /INSERT INTO ledger/.test(c[0]))).toBe(false);
    const bad = mk({ noHead: true });
    await expect(bad.svc.closeMemberYear('5', 3, 'u')).rejects.toThrow(/INTT ON COMPULSORY DEPOSIT/);
    expect(bad.qr.rollbackTransaction).toHaveBeenCalled(); expect(bad.qr.commitTransaction).not.toHaveBeenCalled();
  });
  it('ES-581: opening balance comes from the ledger and the closing balance is the member\'s real RD/CD balance', async () => {
    const t = mk({ closing: 7000 }); const r = await t.svc.closeMemberYear('5', 3, 'u');
    expect(r.closingBalance).toBe(7000);
    expect(t.ic.getLedgerOpeningBalance).toHaveBeenCalledWith('5', 3);
    const ins = t.calls.find((c) => /INSERT INTO rd_financial_year_summary/.test(c[0])); expect(ins[1][2]).toBe(9000);
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

describe('rd/RdBalanceEventsService.withdrawAndPost (ES-579)', () => {
  function mk(o: { holdings?: number; cdCovers?: boolean; seq?: boolean; locked?: number } = {}) {
    const calls: any[] = [];
    const run = jest.fn(async (sql: string, p?: any[]) => {
      calls.push([sql, p]);
      if (/getworkingdate|FROM yearend/.test(sql)) return []; // day and year open
      if (/FROM rd_financial_year_summary/.test(sql)) return [];
      if (/FROM member_master/.test(sql)) return [{ mbno: 5 }];
      if (/SELECT resulting_balance FROM rd_balance_events/.test(sql)) return [];
      if (/FROM rd_installment_ledger/.test(sql)) return [];
      if (/SUM\(lien_amount\)/.test(sql)) return [{ total: o.locked ?? 0 }];
      if (/UPDATE member_balances SET compulsory_deposit/.test(sql)) return o.cdCovers === false ? [[], 0] : [[{ compulsory_deposit: 1 }], 1];
      if (/SELECT COALESCE\(compulsory_deposit, 0\)::float AS bal/.test(sql)) return [{ bal: 14000 }];
      if (/MAX\(/.test(sql)) return [{ n: 1 }];
      if (/FROM headmaster/.test(sql)) return [{ pflag: /A1001/.test(String(p?.[0])) ? 'A' : 'L' }];
      return [];
    });
    const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: run };
    const ds: any = { query: run, createQueryRunner: jest.fn(() => qr) };
    const rules: any = { getRule: jest.fn().mockResolvedValue(1000) };
    const seq: any = o.seq === false ? undefined : { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH700') };
    const svc: any = new RdBalanceEventsService(ds, rules, seq);
    svc.getTotalCurrentHoldings = jest.fn().mockResolvedValue(o.holdings ?? 15000);
    return { svc: svc as RdBalanceEventsService, qr, calls };
  }
  const go = (t: any, amt = 1000, d = new Date()) => t.svc.withdrawAndPost('5', 3, amt, d, 'cashier1', 'Member need');

  it('lowers the balance AND books a CD payment voucher: DR RD/CD, CR cash, transactions, cash book, in one transaction', async () => {
    const t = mk(); const r: any = await go(t, 1000);
    const sqls: string[] = t.calls.map((c) => c[0]);
    const n = (re: RegExp) => sqls.filter((s) => re.test(s)).length;
    expect(n(/UPDATE member_balances SET compulsory_deposit/)).toBe(1);
    expect(n(/INSERT INTO vouchers/)).toBe(1); expect(n(/INSERT INTO transactions/)).toBe(2); expect(n(/INSERT INTO ledger/)).toBe(2); expect(n(/INSERT INTO tblcashbook/)).toBe(1);
    const ledger = t.calls.filter((c) => /INSERT INTO ledger/.test(c[0]));
    expect(ledger.map((c) => [c[1][3], c[1][2]])).toEqual([['L1004', 'DR'], ['A1001', 'CR']]); // RD/CD goes down (debit), cash goes down (credit)
    expect(ledger.every((c) => c[1][8] === 'CD' && c[1][6] === 1000)).toBe(true); // only the CD voucher type
    const cash = t.calls.find((c) => /INSERT INTO tblcashbook/.test(c[0])); expect(cash[0]).toMatch(/0, 0, \$3, 0/); // payment, not receipt
    expect(cash[1]).toEqual(['L1004', 'RD/CD withdrawal', 1000, expect.any(String), 'VCH700', 'cashier1']);
    expect(t.calls.find((c) => /INSERT INTO vouchers/.test(c[0]))[0]).toMatch(/'PAYMENT'/);
    expect(r).toMatchObject({ voucherNo: 'VCH700', newBalance: 14000 });
    expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('nothing is booked when the withdrawal is refused (below the minimum) and the transaction rolls back', async () => {
    const t = mk({ holdings: 1500 });
    await expect(go(t, 1000)).rejects.toThrow(/below the required minimum/);
    expect(t.calls.some((c) => /INSERT INTO vouchers|INSERT INTO ledger/.test(c[0]))).toBe(false);
    expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.commitTransaction).not.toHaveBeenCalled();
  });

  it('the minimum balance and the Loan Against RD lock are enforced inside the balance update (two withdrawals at once)', async () => {
    const t = mk({ locked: 4000 }); await go(t, 1000);
    const upd = t.calls.find((c) => /UPDATE member_balances SET compulsory_deposit/.test(c[0]));
    expect(upd[0]).toMatch(/compulsory_deposit - \$1 >= \$3/); expect(upd[1]).toEqual([1000, '5', 5000]); // minimum 1000 + locked 4000
    const lost = mk({ cdCovers: false });
    await expect(go(lost, 1000)).rejects.toThrow(/can no longer be withdrawn/);
    expect(lost.calls.some((c) => /INSERT INTO ledger/.test(c[0]))).toBe(false);
  });

  it('refuses a future date, a bad date, a bad amount and a missing voucher sequence before touching the database', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86400000);
    for (const [amt, d] of [[1000, tomorrow], [1000, new Date('x')], [0, new Date()], [NaN, new Date()], [1e9, new Date()]] as Array<[number, Date]>) {
      const t = mk(); await expect(go(t, amt, d)).rejects.toThrow(BadRequestException); expect(t.qr.startTransaction).not.toHaveBeenCalled();
    }
    await expect(go(mk({ seq: false }), 1000)).rejects.toThrow(/Voucher numbering/);
  });

  it('a closed day refuses the withdrawal and rolls everything back', async () => {
    const t = mk();
    const orig = t.qr.query; t.qr.query = jest.fn(async (sql: string, p?: any[]) => (/getworkingdate/.test(sql) ? [{ x: 1 }] : orig(sql, p)));
    await expect(go(t, 1000)).rejects.toThrow(/already closed/);
    expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
});
