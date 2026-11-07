import { CashBookService } from '../../../src/modules/cashbook/cashbook.service';

type Line = { code: string; trans_type: string; trans_amt: string | number };

const query = (opts: { rows?: Line[]; raw?: any; fail?: Error }) => {
  const q: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(opts.rows ?? []),
    getRawOne: opts.fail ? jest.fn().mockRejectedValue(opts.fail) : jest.fn().mockResolvedValue(opts.raw ?? null),
    getOne: jest.fn().mockResolvedValue((opts as any).one ?? null),
    getMany: jest.fn().mockResolvedValue([]),
  };
  return q;
};

const build = (rows: Line[], opening: any, heads: any[] = []) => {
  const entriesQuery = query({ rows });
  const openingQuery = query(opening instanceof Error ? { fail: opening } : { raw: opening });
  const ledger: any = {
    createQueryBuilder: jest.fn()
      .mockReturnValueOnce(entriesQuery)
      .mockReturnValueOnce(openingQuery)
      .mockReturnValue(query({ rows: [] })),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
  };
  const transactions: any = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    createQueryBuilder: jest.fn(() => query({ raw: { maxTransNo: 7 } })),
  };
  const members: any = { find: jest.fn().mockResolvedValue([]) };
  const interest: any = { createQueryBuilder: jest.fn(() => query({ raw: null })) };
  const headMaster: any = { find: jest.fn().mockResolvedValue(heads) };
  const headOrder: any = { sortByHeadOrder: jest.fn(async (items) => items) };
  const service = new CashBookService(ledger, transactions, members, interest, headMaster, headOrder);
  return { service, ledger, transactions, headMaster, headOrder, entriesQuery, openingQuery };
};

describe('CashBookService report', () => {
  it('groups receipts and payments by trimmed head code and balances the day', async () => {
    const { service, headOrder } = build([
      { code: ' A1001 ', trans_type: 'CR', trans_amt: '100' },
      { code: 'A1001', trans_type: 'DR', trans_amt: '40' },
      { code: 'L1001', trans_type: 'CR', trans_amt: '25.5' },
    ], { balance: '1000' }, [{ code: 'A1001', head_name: 'Cash in Hand' }, { code: 'L1001', head_name: 'Savings' }]);

    const report = await service.getCashBookReport({ date: '2026-09-20' });

    expect(report.totalReceipts).toBeCloseTo(125.5);
    expect(report.totalPayments).toBeCloseTo(40);
    expect(report.netBalance).toBeCloseTo(85.5);
    expect(report.openingBalance).toBe(1000);
    expect(report.closingBalance).toBeCloseTo(1085.5);
    expect(report.entries).toEqual([
      { code: 'A1001', headName: 'Cash in Hand', receipt: 100, payment: 40 },
      { code: 'L1001', headName: 'Savings', receipt: 25.5, payment: 0 },
    ]);
    expect(headOrder.sortByHeadOrder).toHaveBeenCalled();
  });

  it('falls back to "Head <code>" when headmaster has no row', async () => {
    const { service } = build([{ code: 'X9999', trans_type: 'DR', trans_amt: '12' }], { balance: 0 });
    const report = await service.getCashBookReport({ date: '2026-09-20' });
    expect(report.entries[0]).toMatchObject({ code: 'X9999', headName: 'Head X9999', payment: 12 });
  });

  it('counts legacy receipt rows (R) as receipts, like every other report does', async () => {
    const { service } = build([{ code: 'A1001', trans_type: 'R', trans_amt: '50' }], { balance: 0 });
    const report = await service.getCashBookReport({ date: '2026-09-20' });
    expect(report.totalReceipts).toBe(50);
    expect(report.entries[0].receipt).toBe(50);
  });

  it('rejects a non-numeric ledger amount instead of returning a NaN total', async () => {
    const { service } = build([{ code: 'A1001', trans_type: 'CR', trans_amt: 'not-a-number' }], { balance: 0 });
    await expect(service.getCashBookReport({ date: '2026-09-20' })).rejects.toThrow();
  });

  it('fails clearly when the opening-balance query fails instead of reporting zero', async () => {
    const { service } = build([], new Error('database unavailable'));
    await expect(service.getCashBookReport({ date: '2026-09-20' })).rejects.toThrow();
  });
});

describe('CashBookService transaction staging', () => {
  it('posts a credit amount for a receipt and marks it as a receipt voucher', async () => {
    const { service, ledger, transactions } = build([], { balance: 0 });
    const saved = await service.createTransaction({
      transDate: '2026-09-20', transType: 'CR', credit: 250, debit: 0,
      headCode: 'A001', memberCode: '1001', narration: 'savings', createdBy: 'clerk',
    } as any);

    expect(saved).toMatchObject({ trans_no: 8, trans_type: 'CR', mbno: 1001, trans_amt: '250', vchr_type: 'R', pass_flag: 'N' });
    expect(transactions.save).toHaveBeenCalled();
    expect(ledger.save).toHaveBeenCalledWith(expect.objectContaining({ trans_no: 8, code: 'A001', trans_amt: 250, vchr_type: 'R' }));
  });

  it('posts the debit amount for a payment', async () => {
    const { service, ledger } = build([], { balance: 0 });
    await service.createTransaction({
      transDate: '2026-09-20', transType: 'DR', credit: 0, debit: 75,
      headCode: 'A001', memberCode: '1001', createdBy: 'clerk',
    } as any);
    expect(ledger.save).toHaveBeenCalledWith(expect.objectContaining({ trans_type: 'DR', trans_amt: 75, vchr_type: 'P' }));
  });

  it('returns the latest interest rate and falls back to 4% when the table is empty', async () => {
    const { service } = build([], { balance: 0 });
    await expect(service.getCurrentInterestRate()).resolves.toBe(4);
  });
});
