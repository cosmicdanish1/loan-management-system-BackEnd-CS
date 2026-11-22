import { BadRequestException } from '@nestjs/common';
import { PassTransactionService } from '../../../src/modules/transaction/services-v2/pass-transaction.service';

// Pass Transactions for the vouchers made in Receipt, Payment Voucher Creation and Voucher Payment (ES-604..612).

type Call = { sql: string; params?: any[] };

const build = (opts: {
  header?: any; details?: any[]; stagedRows?: any[]; balances?: Record<string, number>;
  demandRows?: any[]; closePastDays?: boolean;
} = {}) => {
  const calls: Call[] = [];
  let today: string | undefined;
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM getworkingdate')) {
        // the first day asked about is today (Pass always checks today first); with closePastDays every other day is closed
        if (today === undefined) today = String(params?.[0]);
        return opts.closePastDays && String(params?.[0]) !== today ? [{ 1: 1 }] : [];
      }
      if (sql.includes('FROM vouchers WHERE "voucherNumber"')) return opts.header ? [opts.header] : [];
      if (/SELECT mbno, code, trans_type, trans_amt(, acc_type)? FROM transactions WHERE receipt_vchr_no/.test(sql)) return opts.stagedRows ?? opts.details ?? [];
      if (/FROM transactions WHERE receipt_vchr_no/.test(sql)) return opts.details ?? [];
      if (sql.includes('MAX(ledgerid)')) return [{ max_id: '10' }];
      if (sql.includes('FROM ledger') && sql.includes('MAX(trans_no)')) return [{ max_no: '20' }];
      if (sql.includes('FROM demand_receipt') && sql.includes('MAX(trans_no)')) return [{ n: '1' }];
      if (sql.includes('FROM demand_master') && sql.includes('FOR UPDATE')) return opts.demandRows ?? [];
      if (sql.includes('officeno FROM member_master')) return [{ officeno: 4 }];
      if (sql.includes('FROM member_balances WHERE mbno')) {
        const key = String(params?.[0]);
        return key in (opts.balances ?? {}) ? [{ bal: String(opts.balances![key]) }] : [];
      }
      if (sql.includes('pflag FROM headmaster')) return [{ pflag: 'A' }];
      return [];
    }),
  };
  const dataSource: any = { createQueryRunner: jest.fn().mockReturnValue(qr) };
  const service = new PassTransactionService(
    dataSource, { getConfigValue: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { service, qr, calls };
};

const header = (over: Partial<Record<string, any>> = {}) => ({
  voucherNumber: 'V1', voucherType: 'RECEIPT', status: 'PENDING', description: 'test', memberId: '610031566',
  remarks: 'VOUCHER_PAYMENT|PAY_MODE:CASH', bankName: null, chequeNumber: null, voucherDate: '2026-11-20T18:30:00.000Z', ...over,
});
const ledgerInserts = (calls: Call[]) => calls.filter(({ sql }) => sql.includes('INSERT INTO ledger'));

describe('Pass Transactions: payment vouchers must be completed in Voucher Payment first', () => {
  it('refuses a payment voucher that is still waiting for the cashier', async () => {
    const { service, calls } = build({ header: header({ voucherType: 'PAYMENT', remarks: 'VOUCHER_PAYMENT|SIGN:PENDING' }) });
    await expect(service.passTransaction('V1')).rejects.toThrow(/not been completed in Voucher Payment/);
    expect(ledgerInserts(calls)).toHaveLength(0);
  });

  it('passes it once the cashier has saved it', async () => {
    const { service, calls } = build({
      header: header({ voucherType: 'PAYMENT' }),
      details: [
        { trans_no: 1, trans_type: 'DR', trans_amt: '70', code: 'A1045', acc_type: 'OTH', mbno: '610031566' },
        { trans_no: 2, trans_type: 'CR', trans_amt: '70', code: 'A1001', acc_type: 'CINH', mbno: '610031566' },
      ],
    });
    await service.passTransaction('V1');
    expect(ledgerInserts(calls)).toHaveLength(2);
  });
});

describe('Pass Transactions: ledger rows of a receipt or payment', () => {
  const receiptDetails = [
    { trans_no: 1, trans_type: 'CR', trans_amt: '100', code: 'A1023', acc_type: 'OTH', mbno: '610031566' },
    { trans_no: 2, trans_type: 'DR', trans_amt: '100', code: 'A1001', acc_type: 'CINH', mbno: '610031566' },
  ];

  it('tags a receipt R and a payment P (not JV) and posts on the voucher\'s own date', async () => {
    const r = build({ header: header(), details: receiptDetails });
    await r.service.passTransaction('V1');
    const rows = ledgerInserts(r.calls);
    expect(rows.every(c => c.params?.[7] === 'R')).toBe(true);
    expect(new Date(rows[0].params?.[1]).toISOString()).toBe('2026-11-20T18:30:00.000Z');

    const p = build({ header: header({ voucherType: 'PAYMENT' }), details: receiptDetails });
    await p.service.passTransaction('V1');
    expect(ledgerInserts(p.calls).every(c => c.params?.[7] === 'P')).toBe(true);
  });

  it('refuses to post a voucher whose own day has since been closed', async () => {
    const { service, calls } = build({ header: header({ voucherDate: '2020-01-02T00:00:00.000Z' }), details: receiptDetails, closePastDays: true });
    await expect(service.passTransaction('V1')).rejects.toBeInstanceOf(BadRequestException);
    expect(ledgerInserts(calls)).toHaveLength(0);
  });

  it('keeps the RD serial number staged on a line as the ledger account number', async () => {
    const { service, calls } = build({
      header: header(),
      details: [
        { trans_no: 1, trans_type: 'CR', trans_amt: '15', code: 'L1004', acc_type: 'CD', mbno: '610031566', acc_no: '77' },
        { trans_no: 2, trans_type: 'DR', trans_amt: '15', code: 'A1001', acc_type: 'CINH', mbno: '610031566', acc_no: '0' },
      ],
      balances: { 610031566: 8483 },
    });
    await service.passTransaction('V1');
    const rows = ledgerInserts(calls);
    expect(rows[0].params?.[13]).toBe('77');
    expect(rows[1].params?.[13]).toBeNull();
  });
});

describe('Pass Transactions: member balances move for receipts and payments (ES-605)', () => {
  const updates = (calls: Call[]) => calls.filter(({ sql }) => sql.startsWith('UPDATE member_balances'));

  it('a receipt on the compulsory deposit raises it', async () => {
    const { service, calls } = build({
      header: header(),
      details: [
        { trans_no: 1, trans_type: 'CR', trans_amt: '50', code: 'L1004', acc_type: 'CD', mbno: '610031566' },
        { trans_no: 2, trans_type: 'DR', trans_amt: '50', code: 'A1001', acc_type: 'CINH', mbno: '610031566' },
      ],
      balances: { 610031566: 8483 },
    });
    await service.passTransaction('V1');
    expect(updates(calls)[0].params).toEqual([8533, '610031566']);
  });

  it('a receipt on the regular loan lowers it, a payment on the emergency loan raises it', async () => {
    const loan = build({
      header: header(),
      details: [{ trans_no: 1, trans_type: 'CR', trans_amt: '100', code: 'A1002', acc_type: 'RLN', mbno: '610031566' }],
      balances: { 610031566: 200000 },
    });
    await loan.service.passTransaction('V1');
    expect(updates(loan.calls)[0].params).toEqual([199900, '610031566']);

    const pay = build({
      header: header({ voucherType: 'PAYMENT' }),
      details: [{ trans_no: 1, trans_type: 'DR', trans_amt: '10', code: 'A1047', acc_type: 'ALN', mbno: '610031566' }],
      balances: { 610031566: 0 },
    });
    await pay.service.passTransaction('V1');
    expect(updates(pay.calls)[0].params).toEqual([10, '610031566']);
  });

  it('a general voucher (no member) moves no balance', async () => {
    const { service, calls } = build({
      header: header({ memberId: null }),
      details: [{ trans_no: 1, trans_type: 'CR', trans_amt: '20', code: 'A1023', acc_type: 'OTH', mbno: '0' }],
    });
    await service.passTransaction('V1');
    expect(updates(calls)).toHaveLength(0);
  });

  it('reversing puts the balance back', async () => {
    const { service, calls } = build({
      header: { ...header(), status: 'POSTED' },
      stagedRows: [{ mbno: '610031566', code: 'L1004', trans_type: 'CR', trans_amt: '50', acc_type: 'CD' }],
      balances: { 610031566: 8533 },
    });
    await service.reverseTransaction('V1');
    expect(updates(calls)[0].params).toEqual([8483, '610031566']);
  });
});

describe('Pass Transactions: Demand Receipt (D voucher)', () => {
  const demandHeader = (over: Partial<Record<string, any>> = {}) =>
    header({ remarks: 'VOUCHER_PAYMENT|PAY_MODE:CASH|RECEIPT_TYPE:DEMAND|DEMAND_MONTH:JAN|DEMAND_YEAR:2027', ...over });
  const details = [
    { trans_no: 1, trans_type: 'CR', trans_amt: '200', code: 'L1004', acc_type: 'CD', mbno: '610031566' },
    { trans_no: 2, trans_type: 'CR', trans_amt: '34', code: 'A1023', acc_type: 'OTH', mbno: '610031566' },
    { trans_no: 3, trans_type: 'DR', trans_amt: '234', code: 'A1001', acc_type: 'CINH', mbno: '610031566' },
  ];

  it('posts the ledger as type D and leaves a trace row per head in demand_receipt', async () => {
    const { service, calls } = build({ header: demandHeader(), details, balances: { 610031566: 0 } });
    await service.passTransaction('V1');
    expect(ledgerInserts(calls).every(c => c.params?.[7] === 'D')).toBe(true);
    const trace = calls.filter(({ sql }) => sql.includes('INSERT INTO demand_receipt'));
    expect(trace).toHaveLength(2);
    expect(trace[0].params?.slice(3, 5)).toEqual([2027, 1]);
  });

  it('marks the member\'s existing demand row for that month as posted', async () => {
    const { service, calls } = build({ header: demandHeader(), details, demandRows: [{ demand_posted: 'N' }], balances: { 610031566: 0 } });
    await service.passTransaction('V1');
    const mark = calls.find(({ sql }) => sql.startsWith('UPDATE demand_master SET demand_posted = \'Y\''));
    expect(mark?.params).toEqual(['610031566', 2027, 1, 'V1']);
  });

  it('builds a by-hand demand row (sd = H) when the member has none that month', async () => {
    const { service, calls } = build({ header: demandHeader(), details, demandRows: [], balances: { 610031566: 0 } });
    await service.passTransaction('V1');
    const insert = calls.find(({ sql }) => sql.includes('INSERT INTO demand_master'));
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain("'H'");
    expect(insert?.params).toEqual(expect.arrayContaining([234, 34, 200, 4]));
  });

  it('refuses when the demand was posted in the meantime', async () => {
    const { service } = build({ header: demandHeader(), details, demandRows: [{ demand_posted: 'Y' }], balances: { 610031566: 0 } });
    await expect(service.passTransaction('V1')).rejects.toThrow(/already posted/);
  });

  it('reversing removes the trace rows and un-posts or deletes the demand row', async () => {
    const { service, calls } = build({ header: { ...demandHeader(), status: 'POSTED' }, stagedRows: [] });
    await service.reverseTransaction('V1');
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM demand_receipt'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("DELETE FROM demand_master WHERE receipt_vchr_no = $1 AND sd = 'H'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("UPDATE demand_master SET demand_posted = 'N'"))).toBe(true);
  });
});
