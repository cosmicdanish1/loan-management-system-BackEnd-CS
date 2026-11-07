import { ConsolidationService } from '../../../src/modules/consolidation/consolidation.service';

const row = (over: Partial<Record<string, any>>) => ({
  ledgerid: 1, head_code: 'L1001', head_name: 'Savings', trans_type: 'CR', amount: '100',
  mb_no: '1001', member_name: 'Asha Patil', ...over,
});

const build = (opts: { rows?: any[]; opening?: any; move?: any } = {}) => {
  const transactions: any = {
    query: jest.fn()
      .mockResolvedValueOnce(opts.rows ?? [])
      .mockResolvedValueOnce([opts.opening ?? { balance: '1000' }])
      .mockResolvedValueOnce([opts.move ?? { cash_in: '100', cash_out: '40' }]),
  };
  const heads: any = { findOne: jest.fn() };
  const headOrder: any = { sortByHeadOrder: jest.fn(async (items) => items) };
  const service = new ConsolidationService(transactions, heads, headOrder);
  return { service, transactions, headOrder };
};

describe('ConsolidationService', () => {
  it('splits the day into receipt and payment groups with member sub-entries', async () => {
    const { service, transactions, headOrder } = build({
      rows: [
        row({ ledgerid: 1, head_code: 'L1001', head_name: 'Savings', trans_type: 'CR', amount: '100', mb_no: '1001', member_name: 'Asha Patil' }),
        row({ ledgerid: 2, head_code: 'L1001', head_name: 'Savings', trans_type: 'CR', amount: '50', mb_no: '1002', member_name: 'Bala Rao' }),
        row({ ledgerid: 3, head_code: 'A1002', head_name: 'Loan', trans_type: 'DR', amount: '40', mb_no: '0', member_name: '' }),
      ],
    });

    const report = await service.getConsolidationReport({ date: '2026-09-20' } as any);

    expect(report.openingBalance).toBe(1000);
    expect(report.totalReceipts).toBe(100);
    expect(report.totalPayments).toBe(40);
    expect(report.totalCash).toBe(1100);
    expect(report.closingBalance).toBe(1060);
    expect(report.netBalance).toBe(60);
    expect(report.totalHeads).toBe(2);
    expect(report.receiptGroups).toHaveLength(1);
    expect(report.receiptGroups[0].total).toBe(150);
    expect(report.receiptGroups[0].subEntries).toEqual([
      { mbNo: '1001', memberName: 'Asha Patil', amount: 100 },
      { mbNo: '1002', memberName: 'Bala Rao', amount: 50 },
    ]);
    expect(report.paymentGroups[0].subEntries[0]).toMatchObject({ mbNo: '', memberName: 'Miscellineous' });
    expect(headOrder.sortByHeadOrder).toHaveBeenCalledTimes(2);
    expect(transactions.query).toHaveBeenCalledTimes(3);
  });

  it('labels a member without a name row instead of leaving the line blank', async () => {
    const { service } = build({
      rows: [row({ mb_no: '1003', member_name: '' })],
      move: { cash_in: '0', cash_out: '0' },
    });
    const report = await service.getConsolidationReport({ date: '2026-09-20' } as any);
    expect(report.receiptGroups[0].subEntries[0]).toMatchObject({ mbNo: '1003', memberName: 'Member 1003' });
  });

  it('falls back to the head code when headmaster has no name', async () => {
    const { service } = build({
      rows: [row({ head_code: 'Z9000', head_name: null })],
      move: { cash_in: '0', cash_out: '0' },
    });
    const report = await service.getConsolidationReport({ date: '2026-09-20' } as any);
    expect(report.receiptGroups[0]).toMatchObject({ headCode: 'Z9000', headName: 'Z9000' });
  });

  it('treats legacy R/P rows as receipts/payments like the Day Book does', async () => {
    const { service } = build({
      rows: [
        row({ ledgerid: 1, trans_type: 'R', amount: '30' }),
        row({ ledgerid: 2, trans_type: 'P', amount: '10' }),
      ],
      move: { cash_in: '30', cash_out: '10' },
    });

    const report = await service.getConsolidationReport({ date: '2026-09-20' } as any);

    expect(report.receiptGroups[0].total).toBe(30);
    expect(report.paymentGroups[0].total).toBe(10);
  });

  it('rejects an invalid date without querying', async () => {
    const { service, transactions } = build();
    await expect(service.getConsolidationReport({ date: '20/09/2026' } as any)).rejects.toThrow();
    expect(transactions.query).not.toHaveBeenCalled();
  });
});
