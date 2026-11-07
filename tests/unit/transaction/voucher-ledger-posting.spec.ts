import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VoucherService } from '../../../src/modules/transaction/services-v2/voucher.service';
import { LedgerPostingService } from '../../../src/modules/transaction/services-v2/ledger-posting.service';

function runner(route: (sql: string, p?: any[]) => any) {
  const calls: any[] = [];
  const query = jest.fn(async (sql: string, p?: any[]) => { calls.push([sql, p]); const r = route(sql, p); return r === undefined ? [] : r; });
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query };
  return { qr, ds: { query, createQueryRunner: jest.fn(() => qr) } as any, calls };
}

describe('transaction/VoucherService.createVoucher', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  const mk = (o: { heads?: string[]; member?: any[] } = {}) => {
    const r = runner((sql) => {
      if (/FROM headmaster/.test(sql)) return (o.heads ?? ['L1001', 'A1001']).map((code) => ({ code }));
      if (/FROM member_master/.test(sql)) return o.member ?? [{ mbno: 5 }];
      if (/MAX\(/.test(sql)) return [{ next_id: 10 }];
      return undefined;
    });
    const seq: any = { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH001') };
    const notif: any = { sendManualNotification: jest.fn().mockResolvedValue(undefined) };
    return { svc: new VoucherService(r.ds, seq, notif, { isReagreementCase: jest.fn().mockResolvedValue(false) } as any), ...r, notif };
  };
  const dto = (o: any = {}) => ({ voucherType: 'RECEIPT', paymentMethod: 'CASH', description: 'x', memberId: 5, transactions: [{ amount: 100, code: 'L1001' }], ...o });

  it('needs at least one entry', async () => { await expect(mk().svc.createVoucher(dto({ transactions: [] }))).rejects.toThrow(/At least one entry/); });
  it('every amount must be a number (text and missing are refused)', async () => {
    for (const amount of ['abc', '', undefined, null, NaN]) await expect(mk().svc.createVoucher(dto({ transactions: [{ amount, code: 'L1001' }] }))).rejects.toThrow(/amount must be a number/);
  });
  it('numeric text is accepted as a number', async () => { await expect(mk().svc.createVoucher(dto({ transactions: [{ amount: '250.50', code: 'L1001' }] }))).resolves.toMatchObject({ success: true }); });
  it('unknown head codes are refused and named', async () => { await expect(mk({ heads: [] }).svc.createVoucher(dto())).rejects.toThrow(/Unknown head code\(s\): L1001/); });
  it('zero, negative and absurd amounts are refused', async () => {
    for (const amount of [0, -500, 1e12]) await expect(mk().svc.createVoucher(dto({ transactions: [{ amount, code: 'L1001' }] }))).rejects.toThrow(BadRequestException);
  });
  it('only RECEIPT and PAYMENT voucher types are accepted', async () => { await expect(mk().svc.createVoucher(dto({ voucherType: 'BOGUS' }))).rejects.toThrow(BadRequestException); });
  it('an unknown member is refused', async () => { await expect(mk({ member: [] }).svc.createVoucher(dto())).rejects.toThrow(BadRequestException); });
  it('bank mode needs the bank head', async () => { await expect(mk().svc.createVoucher(dto({ paymentMethod: 'BANK' }))).rejects.toThrow(/bankCode/); });
  it('stages a PENDING voucher header, one row per entry and a balancing counter row, all unpassed', async () => {
    const t = mk(); await t.svc.createVoucher(dto({ transactions: [{ amount: 100, code: 'L1001' }, { amount: 50, code: 'L1001' }] }));
    const rows = t.calls.filter((c) => /INSERT INTO transactions/.test(c[0])); expect(rows).toHaveLength(3);
    expect(t.calls.find((c) => /INSERT INTO vouchers/.test(c[0]))[1].slice(4, 9)).toEqual([150, 'x', 5, '', 'PENDING']);
    expect(rows[2][1][1]).toBe('DR'); expect(rows[2][1][4]).toBe(150); expect(rows[2][1][9]).toBe('A1001'); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('a payment books the counter row as CR on cash', async () => {
    const t = mk(); await t.svc.createVoucher(dto({ voucherType: 'PAYMENT' })); const rows = t.calls.filter((c) => /INSERT INTO transactions/.test(c[0])); expect(rows[0][1][1]).toBe('P'); expect(rows[1][1][1]).toBe('CR');
  });
  it('bank mode uses the bank head as the counter account', async () => {
    const t = mk({ heads: ['L1001', 'A2000'] }); await t.svc.createVoucher(dto({ paymentMethod: 'BANK', bankCode: 'A2000' }));
    const counter = t.calls.filter((c) => /INSERT INTO transactions/.test(c[0])).pop(); expect(counter![1][9]).toBe('A2000');
  });
  it('the signed-in user is recorded, not a fixed "admin"', async () => {
    const t = mk(); await t.svc.createVoucher(dto({ createdBy: 'bob' }));
    expect(t.calls.filter((c) => /INSERT INTO transactions/.test(c[0])).every((c) => c[0].includes("'admin'") === false)).toBe(true);
  });
  it('a failure rolls back and releases; HTTP errors keep their status', async () => {
    const t = mk(); t.qr.query.mockImplementation(async (sql: string) => { if (/INSERT INTO vouchers/.test(sql)) throw new Error('db'); if (/FROM headmaster/.test(sql)) return [{ code: 'L1001' }]; if (/FROM member_master/.test(sql)) return [{ mbno: 5 }]; if (/MAX/.test(sql)) return [{ next_id: 1 }]; return []; });
    await expect(t.svc.createVoucher(dto())).rejects.toThrow(/Failed to create voucher: db/); expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('staging a voucher sends no member notification (the member is told once the voucher is passed, ES-413)', async () => {
    const t = mk(); await expect(t.svc.createVoucher(dto())).resolves.toMatchObject({ voucherNo: 'VCH001' }); expect(t.notif.sendManualNotification).not.toHaveBeenCalled();
  });
  it('a voucher with a pending notification does not tell the member before the voucher is passed', async () => {
    const t = mk(); await t.svc.createVoucher(dto()); expect(t.notif.sendManualNotification).not.toHaveBeenCalled();
  });
});

describe('transaction/VoucherService.generateLoanVoucher and deleteVoucher', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  const mk = (o: { loan?: any[]; existing?: any[]; voucher?: any[] } = {}) => {
    const r = runner((sql) => {
      if (/FROM loan_pending/.test(sql)) return o.loan ?? [{ loancaseno: 7, mbno: 5, sanctioned_amt: '100000', loantype: 'RLN' }];
      if (/LOAN_CASE:/.test(sql) || /FROM vouchers WHERE "remarks"/.test(sql)) return o.existing ?? [];
      if (/FROM vouchers WHERE "voucherNumber"/.test(sql)) return o.voucher ?? [];
      if (/MAX\(/.test(sql)) return [{ next_id: 10 }];
      return undefined;
    });
    return { svc: new VoucherService(r.ds, { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH002') } as any, {} as any, { isReagreementCase: jest.fn().mockResolvedValue(false), onVoucherRejected: jest.fn() } as any), ...r };
  };
  const lv = (o: any = {}) => ({ loanCaseNo: 7, paymentMode: 'CASH', breakdown: [{ amount: 100000, code: 'A1002', name: 'Loan' }], ...o });
  it('a case that is not sanctioned or already disbursed is refused', async () => { await expect(mk({ loan: [] }).svc.generateLoanVoucher(lv())).rejects.toThrow(/not found or not sanctioned or already disbursed/); });
  it('stages a payment voucher with the loan case in the remarks', async () => {
    const t = mk(); expect(await t.svc.generateLoanVoucher(lv())).toMatchObject({ success: true, voucherNo: 'VCH002' });
    expect(t.calls.find((c) => /INSERT INTO vouchers/.test(c[0]))[1][9]).toBe('LOAN_CASE:7|PAY_MODE:CASH');
  });
  it('a second voucher for the same sanctioned case is refused while one is pending', async () => {
    const t = mk({ existing: [{ voucherNumber: 'VCH001' }] }); await expect(t.svc.generateLoanVoucher(lv())).rejects.toThrow(BadRequestException);
  });
  it('the voucher amount is the sanctioned amount; a client supplied amount cannot exceed it', async () => {
    await expect(mk().svc.generateLoanVoucher(lv({ actualAmount: 5_000_000 }))).rejects.toThrow(BadRequestException);
  });
  it('the breakdown lines must add up to the voucher total', async () => {
    await expect(mk().svc.generateLoanVoucher(lv({ breakdown: [{ amount: 50000, code: 'A1002', name: 'Loan' }] }))).rejects.toThrow(BadRequestException);
  });
  it('delete: unknown voucher 404, only PENDING can be deleted', async () => {
    await expect(mk().svc.deleteVoucher('X')).rejects.toThrow(NotFoundException);
    await expect(mk({ voucher: [{ status: 'POSTED' }] }).svc.deleteVoucher('X')).rejects.toThrow(/Only PENDING vouchers can be deleted/);
  });
});

describe('transaction/LedgerPostingService (demand posting)', () => {
  const rowsOf = (rows: any[]) => runner((sql) => (/FROM demand_master dm/.test(sql) ? rows : /MAX\(trans_no\)/.test(sql) ? [{ next_no: 10, next_ledger_id: 20 }] : undefined));
  const mk = (rows: any[] = []) => { const r = rowsOf(rows); return { svc: new LedgerPostingService({} as any, r.ds), ...r }; };
  const row = (o: any = {}) => ({ mbno: 5, totaldemand: '1000', balance_for_month: '0', principal: '600', interest: '300', savings: '100', member_name: 'A B', ...o });
  it('an unknown month name or year gives an empty summary', async () => { const t = mk(); expect(await t.svc.getSummary({ month: 'XXX', year: '2026', branch: '' })).toEqual([]); expect(await t.svc.getSummary({ month: 'JAN', year: 'abc', branch: '' })).toEqual([]); });
  it('splits a member demand into principal, interest and savings with totals', async () => {
    const [m] = await mk([row()]).svc.getSummary({ month: 'MAR', year: '2026', branch: '' });
    expect(m.heads.map((h: any) => [h.code, h.demandSend])).toEqual([['PRINCIPAL', 600], ['INTEREST', 300], ['SAVINGS', 100]]); expect(m).toMatchObject({ totalSend: 1000, totalReceived: 1000, totalShort: 0 });
  });
  it('a short recovery is spread over the heads in proportion', async () => {
    const [m] = await mk([row({ balance_for_month: '100' })]).svc.getSummary({ month: 'MAR', year: '2026', branch: '' }); expect(m.totalShort).toBeCloseTo(100, 6); expect(m.heads[0].shortRecovery).toBeCloseTo(60, 6);
  });
  it('a demand without a split is treated as principal', async () => {
    const [m] = await mk([row({ principal: 0, interest: 0, savings: 0 })]).svc.getSummary({ month: 'MAR', year: '2026', branch: '' }); expect(m.heads).toHaveLength(1); expect(m.heads[0]).toMatchObject({ code: 'PRINCIPAL', demandSend: 1000 });
  });
  it('a short recovery above the demand cannot make the received amount negative', async () => {
    const [m] = await mk([row({ balance_for_month: '5000' })]).svc.getSummary({ month: 'MAR', year: '2026', branch: '' }); expect(m.totalReceived).toBeGreaterThanOrEqual(0);
  });
  it('only unposted demands of the month are read and the branch is a bound parameter', async () => {
    const t = mk(); await t.svc.getSummary({ month: 'MAR', year: '2026', branch: "1' OR 1=1" });
    const q = t.calls[0]; expect(q[0]).toContain("COALESCE(dm.demand_posted,'N') <> 'Y'"); expect(q[1]).toEqual([3, 2026, "1' OR 1=1"]); expect(q[0]).not.toContain('OR 1=1');
  });
  it('postUpdate refuses invalid parameters without touching the database', async () => {
    const t = mk(); for (const dto of [{ month: 'XXX', year: '2026', head: 'Loan Principal', totalAmount: 100, recordCount: 1 }, { month: 'MAR', year: '2026', head: 'x', totalAmount: 0, recordCount: 1 }, { month: 'MAR', year: '2026', head: 'x', totalAmount: NaN, recordCount: 1 }])
      expect(await t.svc.postUpdate(dto as any)).toEqual({ success: false, message: 'Invalid parameters for ledger posting.' });
    expect(t.qr.connect).not.toHaveBeenCalled();
  });
  it('the amount must match the pending demand, otherwise nothing is posted', async () => {
    const t = mk([row()]); await expect(t.svc.postUpdate({ month: 'MAR', year: '2026', head: 'Loan Principal', totalAmount: 999, recordCount: 1 } as any)).rejects.toThrow(/does not match pending demand/); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
  });
  it('posts a balanced DR/CR pair per demand head and marks the demands posted, in one transaction', async () => {
    const t = mk([row()]); const r = await t.svc.postUpdate({ month: 'MAR', year: '2026', head: 'Loan Principal', totalAmount: 1000, recordCount: 1 } as any);
    const led = t.calls.filter((c) => /INSERT INTO ledger/.test(c[0])); expect(r).toMatchObject({ success: true, totalPosted: 1000 }); expect(led).toHaveLength(6); // principal, interest, savings (ES-414)
    for (let i = 0; i < led.length; i += 2) { expect(led[i][0]).toContain("'DR'"); expect(led[i + 1][0]).toContain("'CR'"); expect(led[i][1][4]).toBe(led[i + 1][1][4]); }
    expect(led.filter((_, i) => i % 2 === 0).map((c) => c[1][4])).toEqual([600, 300, 100]);
    expect(t.calls.some((c) => /UPDATE demand_master SET demand_posted = 'Y'/.test(c[0]))).toBe(true); expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('two simultaneous postings of the same month cannot both be posted (lock before the check)', async () => {
    const t = mk([row()]); await t.svc.postUpdate({ month: 'MAR', year: '2026', head: 'Loan Principal', totalAmount: 1000, recordCount: 1 } as any);
    expect(t.calls.some((c) => /pg_advisory_xact_lock|FOR UPDATE/.test(c[0]))).toBe(true);
  });
  it('the posting posts all the heads of the demand, not just the one in the request', async () => {
    const t = mk([row()]); await t.svc.postUpdate({ month: 'MAR', year: '2026', head: 'Loan Principal', totalAmount: 1000, recordCount: 1 } as any);
    const led = t.calls.filter((c) => /INSERT INTO ledger/.test(c[0])); const codes = led.map((c) => c[1][2]); expect(new Set(codes).size).toBeGreaterThan(2);
  });
});
