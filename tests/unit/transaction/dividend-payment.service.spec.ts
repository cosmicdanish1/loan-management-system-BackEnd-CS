import { DividendPaymentService } from '../../../src/modules/transaction/services-v2/dividend-payment.service';

const build = (opts: { rows?: any[]; failOn?: string } = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (opts.failOn && sql.includes(opts.failOn)) throw new Error('db down');
      // the unpaid warrants of the member (ES-419: the payment total is checked against them)
      if (/SELECT wrno, interest FROM interestpaid/.test(sql)) return [{ wrno: 'WR1', interest: '50' }, { wrno: 'WR2', interest: '120' }].filter((w) => (params?.[1] ?? []).includes(w.wrno));
      return [undefined, 1];
    }),
  };
  const dataSource: any = {
    query: jest.fn().mockResolvedValue(opts.rows ?? []),
    createQueryRunner: jest.fn().mockReturnValue(qr),
  };
  const service = new DividendPaymentService(dataSource);
  return { service, qr, dataSource, calls };
};

describe('DividendPaymentService pending list', () => {
  it('parses money fields and queries by member number', async () => {
    const { service, dataSource } = build({
      rows: [{ id: 1, wrNo: 'WR1', balance: '1000', rate: '8.5', dividend: '85', paid: null }],
    });

    const rows = await service.getPendingDividends('1001');

    expect(rows).toEqual([{ id: 1, wrNo: 'WR1', balance: 1000, rate: 8.5, dividend: 85, paid: null }]);
    expect(dataSource.query.mock.calls[0][1]).toEqual(['1001']);
  });

  it('uses zero for blank or non-numeric money values', async () => {
    const { service } = build({ rows: [{ id: 2, wrNo: 'WR2', balance: null, rate: '', dividend: 'abc' }] });
    const [row] = await service.getPendingDividends('1001');
    expect(row).toMatchObject({ balance: 0, rate: 0, dividend: 0 });
  });
});

describe('DividendPaymentService payment', () => {
  it('marks every listed warrant paid with the payment details', async () => {
    const { service, calls, qr } = build();

    const result = await service.processDividendPayment({
      memberNo: '1001', paymentMode: 'cheque', chequeNo: 'CHQ1', chequeDate: '2026-09-20',
      bankName: 'SBI', narration: 'dividend', vouchers: ['WR1', 'WR2'], totalAmount: 170,
    });

    expect(result.success).toBe(true);
    expect(result.voucherNo).toMatch(/^DV-\d{6}$/);

    const updates = calls.filter(({ sql }) => sql.includes('UPDATE interestpaid'));
    expect(updates).toHaveLength(2);
    expect(updates[0].params).toEqual(expect.arrayContaining(['CHEQUE', 'CHQ1', 'WR1', '1001']));
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('rejects an empty warrant list instead of returning a successful no-op', async () => {
    const { service } = build();
    await expect(service.processDividendPayment({
      memberNo: '1001', paymentMode: 'CASH', vouchers: [], totalAmount: 0,
    })).rejects.toThrow();
  });

  it('rejects a total that does not match the warrants being paid', async () => {
    const { service } = build();
    await expect(service.processDividendPayment({
      memberNo: '1001', paymentMode: 'CASH', vouchers: ['WR1'], totalAmount: 999999,
    })).rejects.toThrow();
  });

  it('rolls back when a warrant update fails', async () => {
    const { service, qr } = build({ failOn: 'UPDATE interestpaid' });
    await expect(service.processDividendPayment({
      memberNo: '1001', paymentMode: 'CASH', vouchers: ['WR1'], totalAmount: 50,
    })).rejects.toThrow('db down');
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });
});
