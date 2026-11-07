import { CompulsoryDepositService } from '../../../src/modules/transaction/services-v2/compulsory-deposit.service';

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
      if (/MAX\(CAST\("voucherNumber" AS INTEGER\)/.test(sql)) return [{ next_vchr: '1001' }];
      if (/MAX\(id\)/.test(sql)) return [{ next_id: '5' }];
      if (/MAX\(trans_no\)/.test(sql)) return [{ next_id: '40' }];
      if (/MAX\(ledgerid\)/.test(sql)) return [{ next_id: '70' }];
      return [];
    }),
  };
  const dataSource: any = {
    query: jest.fn().mockResolvedValue(opts.rows ?? []),
    createQueryRunner: jest.fn().mockReturnValue(qr),
  };
  // ES-461: the voucher number now comes from the shared sequence generator
  const sequenceGenerator: any = { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH1001') };
  const service = new CompulsoryDepositService(dataSource, sequenceGenerator);
  return { service, qr, dataSource, calls };
};

const dto = (over: Partial<Record<string, any>> = {}) => ({
  incomeHeadCode: 'I1002',
  totalAmount: 50,
  narration: 'CD interest',
  distributions: [
    { memberNo: 1001, memberName: 'Asha', currentBalance: 500, postAmount: 50 },
    { memberNo: 1002, memberName: 'Bala', currentBalance: 100, postAmount: 0 },
  ],
  ...over,
});

describe('CompulsoryDepositService lists', () => {
  it('returns the member CD list and the income heads unchanged', async () => {
    const { service, dataSource } = build({ rows: [{ memberNo: 1001, currentBalance: 50 }] });
    await expect(service.getCDAccountList()).resolves.toEqual([{ memberNo: 1001, currentBalance: 50 }]);
    await expect(service.getIncomeHeads()).resolves.toEqual([{ memberNo: 1001, currentBalance: 50 }]);
    expect(dataSource.query).toHaveBeenCalledTimes(2);
  });

  it('rethrows a database failure instead of showing an empty list', async () => {
    const { service, dataSource } = build();
    dataSource.query.mockRejectedValue(new Error('db down'));
    await expect(service.getCDAccountList()).rejects.toThrow('db down');
  });
});

describe('CompulsoryDepositService posting', () => {
  it('posts only positive distributions and credits each member balance', async () => {
    const { service, calls } = build();

    const result = await service.postCDInterestAction(dto(), 'clerk');

    expect(result).toEqual({ success: true, message: 'Successfully posted CD interest. Voucher No: VCH1001', voucherNo: 'VCH1001' });

    const balanceUpdate = calls.find(({ sql }) => sql.includes('UPDATE member_balances'));
    expect(balanceUpdate?.params).toEqual([50, 1001]);

    const creditRows = calls.filter(({ sql }) => sql.includes("VALUES ($1, 'R', NOW()"));
    expect(creditRows).toHaveLength(1);
    expect(creditRows[0].params).toEqual(expect.arrayContaining([1001, 50, 'VCH1001']));
  });

  it('rejects a header total that does not equal the sum of the distributions', async () => {
    const { service } = build();
    await expect(service.postCDInterestAction(dto({
      totalAmount: 100,
      distributions: [{ memberNo: 1001, memberName: 'Asha', currentBalance: 0, postAmount: 50 }],
    }))).rejects.toThrow();
  });

  it('writes the CD head code on the audit ledger row', async () => {
    const { service, calls } = build();
    await service.postCDInterestAction(dto(), 'clerk');

    const ledgerInsert = calls.find(({ sql }) => sql.includes('INSERT INTO ledger'));
    expect(ledgerInsert?.sql).toContain('code');
    expect(ledgerInsert?.params).toContain('L1004');
  });

  it('serializes id allocation before reading MAX so concurrent postings cannot collide', async () => {
    const { service, calls } = build();
    await service.postCDInterestAction(dto(), 'clerk');
    expect(calls.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('rolls back and rethrows when a write fails', async () => {
    const { service, qr } = build({ failOn: 'INSERT INTO transactions' });
    await expect(service.postCDInterestAction(dto(), 'clerk')).rejects.toThrow('db down');
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });
});
