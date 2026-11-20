import { CompulsoryDepositService } from '../../../src/modules/transaction/services-v2/compulsory-deposit.service';

const build = (opts: { rows?: any[]; failOn?: string; heads?: string[]; members?: number[] } = {}) => {
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
      if (/FROM headmaster WHERE UPPER\(TRIM\(code\)\)/.test(sql)) return (opts.heads ?? ['I1002']).includes(params?.[0]) ? [{ '?column?': 1 }] : [];
      if (/SELECT mbno FROM member_master/.test(sql)) {
        return (params?.[0] || []).filter((m: number) => (opts.members ?? [1001, 1002]).includes(Number(m))).map((m: number) => ({ mbno: m }));
      }
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

  describe('ES-570 validation (nothing is written when it fails)', () => {
    const wroteNothing = (calls: Array<{ sql: string }>) =>
      expect(calls.some(({ sql }) => /INSERT INTO|UPDATE member_balances/.test(sql))).toBe(false);

    it('rejects an income head that is not in headmaster', async () => {
      const { service, calls, qr } = build({ heads: ['I1002'] });
      await expect(service.postCDInterestAction(dto({ incomeHeadCode: 'ZZ999' }))).rejects.toThrow(/Unknown income head/);
      wroteNothing(calls);
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });

    it('accepts the head code in lower case or with spaces', async () => {
      const { service } = build({ heads: ['I1002'] });
      await expect(service.postCDInterestAction(dto({ incomeHeadCode: ' i1002 ' }))).resolves.toMatchObject({ success: true });
    });

    it('rejects a member that does not exist', async () => {
      const { service, calls } = build({ members: [1002] });
      await expect(service.postCDInterestAction(dto())).rejects.toThrow(/Unknown member number\(s\): 1001/);
      wroteNothing(calls);
    });

    it('rejects the same member twice', async () => {
      const { service, calls } = build();
      await expect(service.postCDInterestAction(dto({
        totalAmount: 100,
        distributions: [
          { memberNo: 1001, memberName: 'Asha', currentBalance: 0, postAmount: 50 },
          { memberNo: 1001, memberName: 'Asha', currentBalance: 0, postAmount: 50 },
        ],
      }))).rejects.toThrow(/more than once/);
      wroteNothing(calls);
    });

    it('does not count a member twice when the repeat has a zero amount', async () => {
      const { service } = build();
      await expect(service.postCDInterestAction(dto({
        distributions: [
          { memberNo: 1001, memberName: 'Asha', currentBalance: 0, postAmount: 50 },
          { memberNo: 1001, memberName: 'Asha', currentBalance: 0, postAmount: 0 },
        ],
      }))).resolves.toMatchObject({ success: true });
    });
  });

  it('reads the income heads from headmaster (pflag I), not the empty main table (ES-571)', async () => {
    const { service, dataSource } = build({ rows: [{ code: 'I1002', name: 'INTT FROM MEMBER' }] });
    await service.getIncomeHeads();
    const sql = String(dataSource.query.mock.calls[0][0]);
    expect(sql).toMatch(/FROM headmaster/);
    expect(sql).toMatch(/pflag = 'I'/);
    expect(sql).not.toMatch(/FROM main\b/);
  });

  it('writes the CD head code on the audit ledger row', async () => {
    const { service, calls } = build();
    await service.postCDInterestAction(dto(), 'clerk');

    const ledgerInsert = calls.find(({ sql }) => sql.includes('INSERT INTO ledger'));
    expect(ledgerInsert?.sql).toContain('code');
    expect(ledgerInsert?.params).toContain('L1004');
  });

  it('ES-578: the ledger gets a CR L1004 (type CD) per member AND the matching DR of the income head, so it balances', async () => {
    const { service, calls } = build();
    await service.postCDInterestAction(dto({ totalAmount: 80, distributions: [
      { memberNo: 1001, memberName: 'A', currentBalance: 500, postAmount: 50 },
      { memberNo: 1002, memberName: 'B', currentBalance: 0, postAmount: 30 },
    ] }), 'clerk');
    // params: [trans_no, direction, code, mbno, accType, amount, voucher, pl_balance, narration, username, ledgerid]
    const rows = calls.filter(({ sql }) => sql.includes('INSERT INTO ledger')).map((c) => c.params as any[]);
    expect(rows.map((p) => [p[1], p[2], p[3], p[4], p[5]])).toEqual([
      ['CR', 'L1004', 1001, 'CD', 50],
      ['CR', 'L1004', 1002, 'CD', 30],
      ['DR', 'I1002', 0, 'OTH', 80],
    ]);
    const net = rows.reduce((s, p) => s + (p[1] === 'DR' ? p[5] : -p[5]), 0);
    expect(net).toBe(0); // debits = credits
    expect(rows.every((p) => p[6] === 'VCH1001')).toBe(true);
    // every row has its own trans_no and ledgerid (no NULL, no repeat)
    expect(new Set(rows.map((p) => p[0])).size).toBe(3); expect(new Set(rows.map((p) => p[10])).size).toBe(3);
    expect(rows.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[10]))).toBe(true);
  });

  it('ES-578: the ledger balance column is the real balance after the credit, not a client-sent figure; a member with no balance row gets one', async () => {
    const { service, calls, qr } = build();
    const orig = qr.query.getMockImplementation();
    qr.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (/UPDATE member_balances/.test(sql)) return params?.[1] === 1001 ? [[{ balance: 550 }], 1] : [[], 0]; // 1002 has no balance row
      return orig(sql, params);
    });
    await service.postCDInterestAction(dto({ totalAmount: 80, distributions: [
      { memberNo: 1001, memberName: 'A', currentBalance: 99999, postAmount: 50 },
      { memberNo: 1002, memberName: 'B', currentBalance: 99999, postAmount: 30 },
    ] }), 'clerk');
    const rows = calls.filter(({ sql }) => sql.includes('INSERT INTO ledger')).map((c) => c.params as any[]);
    expect(rows[0][7]).toBe(550);   // real balance from the update, not 99999 + 50
    expect(rows[1][7]).toBe(30);    // new row: the amount itself
    const created = calls.find(({ sql }) => sql.includes('INSERT INTO member_balances'));
    expect(created?.params).toEqual([1002, 30]);
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
