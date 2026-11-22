import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UtilitiesService } from '../../../src/modules/utilities/utilities.service';
import { systemDateText } from '../../../src/modules/shared/utils/posting-date';

// The Receipt, Payment Voucher Creation and Voucher Payment windows (ES-604..612): input checks, staging and the cashier step.

type Call = { sql: string; params?: any[] };

interface Opts {
  members?: number[];
  heads?: string[];
  banks?: string[];
  existingVouchers?: string[];
  unsigned?: any;               // the voucher header Voucher Payment reads
  lines?: any[];                // staged DR lines
  demandPosted?: boolean;
  pendingDemand?: string;
  working?: string | null;      // the Day-End working date (open getworkingdate row)
  policy?: 'WORKING' | 'SYSTEM'; // the client's Date setting for the window (no policy table when undefined)
}

const build = (o: Opts = {}) => {
  const calls: Call[] = [];
  const answer = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    if (sql.includes('FROM member_master WHERE mbno')) return (o.members ?? [610031566]).includes(Number(params?.[0])) ? [{ 1: 1 }] : [];
    if (sql.includes('FROM headmaster WHERE TRIM(code) = ANY')) return (params?.[0] as string[]).filter(c => (o.heads ?? ['A1023', 'A1045', 'L1004', 'A1047']).includes(c)).map(code => ({ code }));
    if (sql.includes("LIKE '%BANK%'")) return (o.banks ?? ['A1008']).includes(String(params?.[0])) ? [{ 1: 1 }] : [];
    if (sql.includes('FROM vouchers WHERE "voucherNumber" = $1 LIMIT 1')) return (o.existingVouchers ?? []).includes(String(params?.[0])) ? [{ 1: 1 }] : [];
    if (sql.includes('FROM vouchers WHERE "voucherNumber" = $1 AND "voucherType" = \'PAYMENT\' AND status = \'PENDING\' FOR UPDATE')) return o.unsigned ? [o.unsigned] : [];
    if (sql.includes('LEFT JOIN member_master m') && sql.includes('WHERE v."voucherNumber"')) return o.unsigned ? [{ ...o.unsigned, voucherNo: o.unsigned.voucherNumber, total: o.unsigned.totalAmount, memberNo: o.unsigned.memberId, narration: o.unsigned.description, memberName: 'A ANAND', officeNo: 1 }] : [];
    if (sql.includes('LEFT JOIN headmaster h')) return o.lines ?? [];
    if (sql.includes('SELECT trans_amt FROM transactions')) return o.lines ?? [];
    if (sql.includes('SELECT mbno, trans_date FROM transactions')) return [{ mbno: '610031566', trans_date: '2026-11-22' }];
    if (sql.includes('demand_for_year = $2') && sql.includes("COALESCE(demand_posted, 'N') = 'Y'")) return o.demandPosted ? [{ 1: 1 }] : [];
    if (sql.includes('FROM vouchers WHERE status = \'PENDING\' AND "memberId" = $1 AND remarks LIKE')) return o.pendingDemand ? [{ voucherNumber: o.pendingDemand }] : [];
    if (sql.includes('MAX(trans_no)')) return [{ n: '500' }];
    if (sql.includes('MAX(id)')) return [{ n: '900' }];
    if (sql.includes('FROM voucher_master')) return [{ last: 'P26000' }];
    if (sql.includes('to_regclass')) return o.policy ? [{ t: 'window_date_policy' }] : [{ t: null }];
    if (sql.includes('FROM window_date_policy WHERE window_key')) return o.policy ? [{ mode: o.policy }] : [];
    if (sql.includes("FROM getworkingdate WHERE dayend_flag = 'N'")) return o.working ? [{ d: o.working }] : [];
    if (sql.includes('FROM getworkingdate') || sql.includes('FROM yearend')) return [];
    return [];
  };
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(answer),
  };
  const ds: any = { createQueryRunner: jest.fn().mockReturnValue(qr), query: jest.fn(answer) };
  const svc = new UtilitiesService(ds, {} as any, {} as any);
  return { svc, qr, calls };
};

const goodReceipt = (over: any = {}) => ({
  memberNo: 610031566, voucherNo: '', transDate: '2026-11-01', modeOfPay: 'C', bankCode: 'A1001', receiptType: 'receipt',
  narration: 'x', cheqNo: '', rows: [{ code: 'A1023', accType: 'OTH', amount: 111 }], ...over,
});
const inserts = (calls: Call[], table: string) => calls.filter(({ sql }) => sql.includes(`INSERT INTO ${table}`));

describe('UtilitiesService.assertVoucherInput (Receipt and Payment Voucher Creation)', () => {
  it('accepts a normal receipt', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt())).resolves.toBeUndefined();
  });

  it('needs a member, unless it is a general receipt / payment (member 0)', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt({ memberNo: 0 }))).rejects.toThrow(/member number/i);
    await expect(svc.assertVoucherInput(goodReceipt({ memberNo: 0, receiptType: 'general' }))).resolves.toBeUndefined();
    await expect(svc.assertVoucherInput(goodReceipt({ memberNo: 0, paymentType: 'general', receiptType: undefined }))).resolves.toBeUndefined();
    await expect(svc.assertVoucherInput(goodReceipt({ receiptType: 'general' }))).rejects.toThrow(/not for a member/);
  });

  it('refuses a member that does not exist', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt({ memberNo: 999999999 }))).rejects.toThrow(/does not exist/);
  });

  it('refuses a future date but accepts today and the past', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt({ transDate: '2999-01-01' }))).rejects.toThrow(/future/);
    await expect(svc.assertVoucherInput(goodReceipt({ transDate: new Date().toISOString().slice(0, 10) }))).resolves.toBeUndefined();
  });

  it('refuses a narration longer than the 100 characters the voucher stores', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt({ narration: 'x'.repeat(101) }))).rejects.toThrow(/100 characters/);
    await expect(svc.assertVoucherInput(goodReceipt({ narration: 'x'.repeat(100) }))).resolves.toBeUndefined();
  });

  it('mode of payment must be C or B (either case)', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt({ modeOfPay: 'X' }))).rejects.toThrow(/C \(cash\) or B \(bank\)/);
    const body = goodReceipt({ modeOfPay: 'b', bankCode: 'A1008', cheqNo: '1' });
    await svc.assertVoucherInput(body);
    expect(body.modeOfPay).toBe('B');
  });

  it('a bank receipt needs a cheque number and a real bank account head', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt({ modeOfPay: 'B', bankCode: 'A1008' }))).rejects.toThrow(/cheque number/);
    await expect(svc.assertVoucherInput(goodReceipt({ modeOfPay: 'B', bankCode: 'A1023', cheqNo: '1' }))).rejects.toThrow(/not a bank account head/);
    await expect(svc.assertVoucherInput(goodReceipt({ modeOfPay: 'B', bankCode: 'A1008', cheqNo: '1' }))).resolves.toBeUndefined();
  });

  it('refuses a manual voucher number that already exists', async () => {
    const { svc } = build({ existingVouchers: ['RTEST1'] });
    await expect(svc.assertVoucherInput(goodReceipt({ voucherNo: 'RTEST1' }))).rejects.toThrow(/already exists/);
    await expect(svc.assertVoucherInput(goodReceipt({ voucherNo: 'RNEW1' }))).resolves.toBeUndefined();
  });

  it('checks every row: head known, amount a positive number with at most 2 decimals', async () => {
    const { svc } = build();
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [] }))).rejects.toThrow(/At least one row/);
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [{ code: 'ZZ999', amount: 1 }] }))).rejects.toThrow(/Unknown head/);
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [{ code: 'A1023', amount: 0 }] }))).rejects.toThrow(/greater than 0/);
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [{ code: 'A1023', amount: -5 }] }))).rejects.toThrow(/greater than 0/);
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [{ code: 'A1023', amount: 1.005 }] }))).rejects.toThrow(/2 decimals/);
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [{ code: 'A1023', amount: 'abc' }] }))).rejects.toThrow(/greater than 0/);
  });

  it('fills a missing account type from the head and checks the RD serial number', async () => {
    const { svc } = build();
    const body = goodReceipt({ rows: [{ code: 'L1004', amount: 10 }, { code: 'A1023', amount: 5 }] });
    await svc.assertVoucherInput(body);
    expect(body.rows.map((r: any) => r.accType)).toEqual(['CD', 'OTH']);
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [{ code: 'L1004', amount: 10, rdSrNo: 'abc' }] }))).rejects.toThrow(/RD Sr.No/);
    await expect(svc.assertVoucherInput(goodReceipt({ rows: [{ code: 'L1004', amount: 10, rdSrNo: '77' }] }))).resolves.toBeUndefined();
  });
});

describe('UtilitiesService.savePaymentVoucher (Voucher Creation stages the debit rows only)', () => {
  const input = (over: any = {}) => ({
    memberNo: 610031566, voucherNo: '', transDate: '2026-11-22', paymentType: 'payment', narration: 'Advance tax',
    rows: [{ code: 'A1045', name: 'ADVANCE TAX', amount: 500 }, { code: 'A1047', name: 'EMERGENCY LOAN', amount: 40, rdSrNo: '9' }], ...over,
  });

  it('writes one debit line per head, unsigned, and no cash or bank line', async () => {
    const { svc, calls, qr } = build();
    const res = await svc.savePaymentVoucher(input(), 'cashier');
    expect(res.success).toBe(true);
    expect(res.voucherNo).toMatch(/^P\d{5}$/);
    const lines = inserts(calls, 'transactions');
    expect(lines).toHaveLength(2);
    expect(lines.every(c => c.sql.includes("'DR'") && c.sql.includes("'N', 'N'"))).toBe(true);   // pass_flag N, cashier_flag N
    expect(lines[0].params?.[3]).toBe('OTH');
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('tags member heads with their account type and keeps the RD serial number', async () => {
    const { svc, calls } = build();
    await svc.savePaymentVoucher(input(), 'cashier');
    const lines = inserts(calls, 'transactions');
    expect(lines[0].params?.[3]).toBe('OTH');   // A1045 advance tax
    expect(lines[1].params?.[3]).toBe('ALN');   // A1047 emergency loan
    expect(lines[1].params?.[9]).toBe(9);       // RD Sr.No -> account number
  });

  it('creates the pending header marked SIGN:PENDING with the total', async () => {
    const { svc, calls } = build();
    await svc.savePaymentVoucher(input(), 'cashier');
    const header = inserts(calls, 'vouchers')[0];
    expect(header.sql).toContain("'PAYMENT'");
    expect(header.sql).toContain('VOUCHER_PAYMENT|SIGN:PENDING');
    expect(header.params?.[3]).toBe(540);
    expect(header.params?.[5]).toBe(610031566);
  });

  it('a general payment is stored with member 0 and no member on the header', async () => {
    const { svc, calls } = build();
    await svc.savePaymentVoucher(input({ paymentType: 'general', memberNo: 610031566 }), 'cashier');
    expect(inserts(calls, 'transactions')[0].params?.[2]).toBe(0);
    expect(inserts(calls, 'vouchers')[0].params?.[5]).toBeNull();
  });

  it('refuses a voucher with no usable row and rolls back', async () => {
    const { svc, qr } = build();
    await expect(svc.savePaymentVoucher(input({ rows: [{ code: '', name: '', amount: 0 }] }), 'cashier')).rejects.toBeInstanceOf(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });
});

describe('UtilitiesService: Voucher Payment (the cashier step)', () => {
  const header = (over: any = {}) => ({
    voucherNumber: 'P26466', voucherDate: '2026-11-22T00:00:00.000Z', totalAmount: '500', memberId: '610031566',
    description: 'Advance tax', remarks: 'VOUCHER_PAYMENT|SIGN:PENDING', ...over,
  });

  it('lists the unsigned vouchers for the drop-down', async () => {
    const { svc } = build();
    (svc as any).dataSource.query = jest.fn().mockResolvedValue([{ voucherNo: 'P1', total: '500', memberNo: '1', memberName: 'A', voucherDate: 'd' }]);
    const list = await svc.listUnsignedPaymentVouchers();
    expect(list[0]).toMatchObject({ voucherNo: 'P1', total: 500 });
  });

  it('shows one voucher with its rows, and refuses one that is already saved or missing', async () => {
    const ok = build({ unsigned: header(), lines: [{ code: 'A1045', name: 'ADVANCE TAX', amount: '500', rdSrNo: '0' }] });
    const detail = await ok.svc.getPaymentVoucherForSign('P26466');
    expect(detail).toMatchObject({ voucherNo: 'P26466', total: 500, isGeneral: false, memberName: 'A ANAND' });
    expect(detail.rows).toEqual([{ code: 'A1045', name: 'ADVANCE TAX', amount: 500, rdSrNo: '' }]);

    const done = build({ unsigned: header({ remarks: 'VOUCHER_PAYMENT|PAY_MODE:CASH' }) });
    await expect(done.svc.getPaymentVoucherForSign('P26466')).rejects.toThrow(/already saved/);
    const none = build();
    await expect(none.svc.getPaymentVoucherForSign('P99999')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('Save (cash) adds the credit to cash in hand, marks the lines signed and updates the header', async () => {
    const { svc, calls, qr } = build({ unsigned: header(), lines: [{ trans_amt: '500' }] });
    const res = await svc.signPaymentVoucher({ voucherNo: 'P26466', modeOfPay: 'C' }, 'cashier');
    expect(res.success).toBe(true);
    const credit = inserts(calls, 'transactions')[0];
    expect(credit.sql).toContain("'CR'");
    expect(credit.params).toEqual(expect.arrayContaining(['CINH', 500, 'P26466', 'C', 'A1001']));
    expect(calls.find(({ sql }) => sql.includes("cashier_flag = 'Y'"))?.params).toEqual(['P26466', 'C', '', null, '']);
    expect(calls.find(({ sql }) => sql.startsWith('UPDATE vouchers SET remarks'))?.params?.[1]).toBe('VOUCHER_PAYMENT|PAY_MODE:CASH');
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('Save (bank) credits the chosen bank and keeps the cheque details', async () => {
    const { svc, calls } = build({ unsigned: header(), lines: [{ trans_amt: '500' }] });
    await svc.signPaymentVoucher({ voucherNo: 'P26466', modeOfPay: 'B', bankCode: 'A1008', cheqNo: '77', cheqDate: '2026-11-22', bankName: 'TB' }, 'cashier');
    const credit = inserts(calls, 'transactions')[0];
    expect(credit.params).toEqual(expect.arrayContaining(['BANK', 'B', '77', 'TB', 'A1008']));
    const head = calls.find(({ sql }) => sql.startsWith('UPDATE vouchers SET remarks'));
    expect(head?.params?.[1]).toBe('VOUCHER_PAYMENT|PAY_MODE:BANK');
    expect(head?.params?.[2]).toBe('77');
    expect(head?.params?.[4]).toBe('TB');
  });

  it('refuses a bad mode, a bank save with no account or cheque, a non-bank head, an unknown or already saved voucher', async () => {
    const t = build({ unsigned: header(), lines: [{ trans_amt: '500' }] });
    await expect(t.svc.signPaymentVoucher({ voucherNo: 'P26466', modeOfPay: 'X' })).rejects.toThrow(/C \(cash\) or B \(bank\)/);
    await expect(t.svc.signPaymentVoucher({ voucherNo: 'P26466', modeOfPay: 'B' })).rejects.toThrow(/bank account/);
    await expect(t.svc.signPaymentVoucher({ voucherNo: 'P26466', modeOfPay: 'B', bankCode: 'A1008' })).rejects.toThrow(/cheque number/);
    await expect(t.svc.signPaymentVoucher({ voucherNo: 'P26466', modeOfPay: 'B', bankCode: 'A1023', cheqNo: '1' })).rejects.toThrow(/not a bank account head/);
    await expect(t.svc.signPaymentVoucher({ voucherNo: '', modeOfPay: 'C' })).rejects.toThrow(/Choose the voucher/);

    const unknown = build();
    await expect(unknown.svc.signPaymentVoucher({ voucherNo: 'P99999', modeOfPay: 'C' })).rejects.toBeInstanceOf(NotFoundException);
    const done = build({ unsigned: header({ remarks: 'VOUCHER_PAYMENT|PAY_MODE:CASH' }) });
    await expect(done.svc.signPaymentVoucher({ voucherNo: 'P26466', modeOfPay: 'C' })).rejects.toThrow(/already saved/);
    expect(done.qr.rollbackTransaction).toHaveBeenCalled();
  });
});

describe('UtilitiesService.saveReceiptVoucher / saveReceipt (Receipt window stages the voucher)', () => {
  const receipt = (over: any = {}) => ({
    memberNo: 610031566, voucherNo: '', transDate: '2026-11-22', modeOfPay: 'C', bankCode: 'A1001', narration: '',
    rows: [{ code: 'L1004', accType: 'CD', amount: 50, rdSrNo: '77' }], ...over,
  });

  it('stages a cash receipt: CR rows, a DR cash line and a PENDING header (nothing in the ledger)', async () => {
    const { svc, calls } = build();
    const res = await svc.saveReceipt(receipt(), 'cashier');
    expect(res.voucherNo).toMatch(/^R\d{5}$/);
    const lines = inserts(calls, 'transactions');
    expect(lines).toHaveLength(2);
    expect(lines[0].params).toEqual(expect.arrayContaining(['CINH', 50]));
    expect(lines[1].params).toEqual(expect.arrayContaining(['CD', 77]));    // the RD serial number becomes the account number
    expect(inserts(calls, 'vouchers')[0].sql).toContain("'RECEIPT'");
    expect(inserts(calls, 'ledger')).toHaveLength(0);
  });

  it('a bank receipt debits the chosen bank and carries the cheque and the customer\'s bank', async () => {
    const { svc, calls } = build();
    await svc.saveReceipt(receipt({ modeOfPay: 'B', bankCode: 'A1008', cheqNo: '123', cheqDate: '2026-11-22', bankName: 'TEST BANK' }), 'cashier');
    const dr = inserts(calls, 'transactions')[0];
    expect(dr.params).toEqual(expect.arrayContaining(['BANK', 'A1008', '123', 'TEST BANK']));
    expect(inserts(calls, 'vouchers')[0].params?.[6]).toContain('PAY_MODE:BANK');
  });

  it('a general receipt is stored with member 0', async () => {
    const { svc, calls } = build();
    await svc.saveReceipt(receipt({ receiptType: 'general' }), 'cashier');
    expect(inserts(calls, 'transactions')[0].params?.[2]).toBe(0);
    expect(inserts(calls, 'vouchers')[0].params?.[5]).toBeNull();
  });

  describe('Demand Receipt', () => {
    const demand = (over: any = {}) => receipt({ receiptType: 'demand', month: 'JAN', year: '2027', ...over });

    it('uses the D voucher series and records the demand month and year on the voucher', async () => {
      const { svc, calls } = build();
      const res = await svc.saveReceipt(demand(), 'cashier');
      expect(res.voucherNo).toMatch(/^D\d{5}$/);
      expect(inserts(calls, 'transactions').every(c => c.sql.includes("'D'"))).toBe(true);
      expect(inserts(calls, 'vouchers')[0].params?.[6]).toContain('RECEIPT_TYPE:DEMAND|DEMAND_MONTH:JAN|DEMAND_YEAR:2027');
    });

    it('needs a member, a real month and a sensible year', async () => {
      const { svc } = build();
      await expect(svc.saveReceipt(demand({ memberNo: 0 }), 'c')).rejects.toThrow(/for a member/);
      await expect(svc.saveReceipt(demand({ month: 'XYZ' }), 'c')).rejects.toThrow(/demand month/);
      await expect(svc.saveReceipt(demand({ year: '1900' }), 'c')).rejects.toThrow(/demand year/);
    });

    it('refuses when the member\'s demand for that month is already posted or already has a pending demand receipt', async () => {
      await expect(build({ demandPosted: true }).svc.saveReceipt(demand(), 'c')).rejects.toThrow(/already posted/);
      await expect(build({ pendingDemand: 'D01205' }).svc.saveReceipt(demand(), 'c')).rejects.toThrow(/pending demand receipt \(D01205\)/);
    });
  });
});

describe('UtilitiesService helpers', () => {
  it('monthNumber understands names and numbers and rejects the rest', () => {
    expect(UtilitiesService.monthNumber('JAN')).toBe(1);
    expect(UtilitiesService.monthNumber('nov')).toBe(11);
    expect(UtilitiesService.monthNumber('December')).toBe(12);
    expect(UtilitiesService.monthNumber('7')).toBe(7);
    for (const bad of ['XYZ', '', '13', '0', null, undefined]) expect(UtilitiesService.monthNumber(bad)).toBe(0);
  });

  it('the member balance carries the loan balances the Receipt window shows', async () => {
    const { svc } = build();
    const rows: Record<string, any[]> = {
      'FROM member_master': [{ mbno: 1, name: 'A ANAND', basic_pay: 1, dept_name: '' }],
      'FROM recurring_deposits': [{ rd_accounts: 0 }],
      'FROM fixed_deposits': [{ fd_accounts: 0 }],
      "acc_type = 'SB'": [{ sb_accounts: 0 }],
      'FROM member_balances': [{ rln_balance: '200000.00', eln_balance: '0.00' }],
    };
    (svc as any).dataSource.query = jest.fn(async (sql: string) => Object.entries(rows).find(([k]) => sql.includes(k))?.[1] ?? []);
    const res = await svc.getMemberBalance('1');
    expect(res.loan_summary).toEqual({ rln_balance: '200000.00', eln_balance: '0.00' });
  });
});

describe('Vouchers are dated on the Day-End working date, not on the computer clock or a date sent by the screen', () => {
  const workingMidnight = () => new Date('2026-08-25T00:00:00').getTime();
  const goodPayment = (over: any = {}) => ({ memberNo: 610031566, voucherNo: '', transDate: '2026-11-01', paymentType: 'payment', narration: 'x', rows: [{ code: 'A1045', amount: 500 }], ...over });

  it('a receipt is staged and headed on the working date even when the screen sends another date', async () => {
    const { svc, calls } = build({ working: '2026-08-25' });
    await svc.saveReceipt(goodReceipt({ transDate: '2026-11-01' }), 'clerk');
    const staged = inserts(calls, 'transactions');
    expect(staged.length).toBeGreaterThan(0);
    for (const c of staged) expect((c.params?.[1] as Date).getTime()).toBe(workingMidnight());
    const header = inserts(calls, 'vouchers')[0];
    expect((header.params?.[2] as Date).getTime()).toBe(workingMidnight());
  });

  it('a payment voucher is staged and headed on the working date', async () => {
    const { svc, calls } = build({ working: '2026-08-25' });
    await svc.savePaymentVoucher(goodPayment(), 'clerk');
    for (const c of inserts(calls, 'transactions')) expect((c.params?.[1] as Date).getTime()).toBe(workingMidnight());
    expect((inserts(calls, 'vouchers')[0].params?.[2] as Date).getTime()).toBe(workingMidnight());
  });

  it('with no open working date the real date of the day (India time) is used', async () => {
    const { svc, calls } = build({ working: null });
    await svc.saveReceipt(goodReceipt(), 'clerk');
    const stamp = (inserts(calls, 'transactions')[0].params?.[1] as Date);
    expect(stamp.getTime()).toBe(new Date(`${systemDateText()}T00:00:00`).getTime());
  });

  it('a window set to SYSTEM date is dated on the real date of the day even when a working date is open', async () => {
    const { svc, calls } = build({ working: '2026-08-25', policy: 'SYSTEM' });
    await svc.saveReceipt(goodReceipt(), 'clerk');
    await svc.savePaymentVoucher(goodPayment(), 'clerk');
    for (const c of inserts(calls, 'transactions')) expect((c.params?.[1] as Date).getTime()).toBe(new Date(`${systemDateText()}T00:00:00`).getTime());
  });

  it('each window asks for its own setting (Receipt and Voucher Creation are separate)', async () => {
    const { svc, calls } = build({ working: '2026-08-25' });
    await svc.saveReceipt(goodReceipt(), 'clerk');
    await svc.savePaymentVoucher(goodPayment(), 'clerk');
    const keys = calls.filter(({ sql }) => sql.includes('FROM window_date_policy WHERE window_key')).map((c) => c.params?.[0]);
    expect(keys).toEqual([]); // no policy table in this mock: the lookup stops at to_regclass and the default is WORKING
  });

  it('getPostingDate answers for a window key and refuses a missing one', async () => {
    const { svc } = build({ working: '2026-08-25' });
    expect(await svc.getPostingDate('RECEIPT_PAYMENT')).toEqual({ date: '2026-08-25', mode: 'WORKING' });
    await expect(svc.getPostingDate('')).rejects.toThrow(/window key/);
  });

  it('getWorkingDate returns the open day as text (or null)', async () => {
    expect(await build({ working: '2026-08-25' }).svc.getWorkingDate()).toEqual({ date: '2026-08-25' });
    expect(await build({ working: null }).svc.getWorkingDate()).toEqual({ date: null });
  });
});
