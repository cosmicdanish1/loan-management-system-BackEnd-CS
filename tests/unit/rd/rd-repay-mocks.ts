/** Test doubles for RdRepaymentService: the query runner its posting transaction uses, and the voucher-number generator. */
export const mkQr = () => ({
  connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
  query: jest.fn(async (sql: string, p: any[] = []) => {
    if (/INSERT INTO rd_installment_ledger/.test(sql)) return [{ paid_amount: String(p[6]), expected_amount: String(p[5]) }];
    if (/UPDATE member_balances/.test(sql)) return [[{ balance: 1000 }], 1]; // TypeORM shape: [rows, count]
    if (/MAX\(/.test(sql)) return [{ n: 1 }];
    if (/FROM headmaster/.test(sql)) return [{ pflag: /A1001/.test(String(p[0])) ? 'A' : 'L' }];
    return [];
  }),
});
export const seq: any = { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH900') };
