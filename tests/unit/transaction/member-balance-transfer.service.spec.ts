import { MemberBalanceTransferService } from '../../../src/modules/transaction/services-v2/member-balance-transfer.service';

interface LedgerRow { dr: number; cr: number }

const build = (opts: {
  members?: string[];
  flags?: Record<string, string>;
  balances?: Record<string, Record<string, LedgerRow>>;
} = {}) => {
  const members = opts.members ?? ['1001'];
  const flags = opts.flags ?? { A1001: 'A', A2001: 'L', L1001: 'L', A3001: 'L' };
  const balances = opts.balances ?? {};
  const calls: Array<{ sql: string; params?: any[] }> = [];

  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql.includes('pflag FROM headmaster')) return [{ pflag: flags[params?.[0]] ?? 'L' }];
      if (sql.includes('SELECT mbno::text as mbno, TRIM')) {
        return members.map((m) => ({ mbno: m, name: `Member ${m}` }));
      }
      if (sql.includes('FROM fundsmaster f')) return members.map((m) => ({ mbno: m, name: `Member ${m}` }));
      if (sql.includes('FROM ledger WHERE code = $1')) {
        const [, mbno] = params || [];
        return [balances[String(mbno)]?.[String(params?.[0])] ?? { dr: 0, cr: 0 }];
      }
      if (sql.includes('MAX(ledgerid)')) return [{ max_id: '0' }];
      if (sql.includes('MAX(trans_no)')) return [{ max_no: '0' }];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('j_vchr_no')) return [{ last: 'J00000' }];
      if (sql.includes('SELECT 1 WHERE EXISTS')) return [];
      return [];
    }),
  };

  const dataSource: any = {
    query: qr.query,
    createQueryRunner: jest.fn().mockReturnValue(qr),
  };
  const service = new MemberBalanceTransferService(dataSource);
  return { service, qr, dataSource, calls };
};

describe('MemberBalanceTransferService generate', () => {
  it('transfers the debit-head balance up to the credit limit and sends the excess to the excess head', async () => {
    const { service } = build({
      balances: {
        '1001': { L1001: { dr: 0, cr: 1000 }, A3001: { dr: 0, cr: 0 } }, // source head L1001 holds 1,000
      },
    });

    const result = await service.generate('L1001', 'A3001', 300, 'A2001', '2026-09-30');

    expect(result.entries).toEqual([{
      srNo: 1, mbno: '1001', name: 'Member 1001', dbHeadBal: 1000, crHeadBal: 0,
      dbAmt: 1000, crAmt: 300, exCrAmt: 700,
    }]);
    expect(result).toMatchObject({ totalDebit: 1000, totalCredit: 300, excCredit: 700 });
  });

  it('reads a debit-normal head as dr - cr and a credit-normal head as cr - dr', async () => {
    const { service } = build({
      flags: { A1001: 'A', L1001: 'L', A3001: 'L' },
      balances: { '1001': { A1001: { dr: 100, cr: 40 }, A3001: { dr: 10, cr: 30 } } },
    });

    const result = await service.generate('A1001', 'A3001', 100, '', '2026-09-30');
    expect(result.entries[0]).toMatchObject({ dbHeadBal: 60, crHeadBal: 20, dbAmt: 60, crAmt: 60, exCrAmt: 0 });
  });

  it('skips a member whose source balance is already zero', async () => {
    const { service } = build({ balances: { '1001': { L1001: { dr: 0, cr: 0 } } } });
    const result = await service.generate('L1001', 'A3001', 1000, '', '2026-09-30');
    expect(result.entries).toEqual([]);
    expect(result).toMatchObject({ totalDebit: 0, totalCredit: 0, excCredit: 0 });
  });

  it('rounds the transfer and excess to two decimals', async () => {
    const { service } = build({
      balances: { '1001': { L1001: { dr: 0, cr: 100.006 }, A3001: { dr: 0, cr: 0 } } },
    });
    const result = await service.generate('L1001', 'A3001', 0, '', '2026-09-30');
    expect(result.entries[0]).toMatchObject({ dbAmt: 100.01, crAmt: 0, exCrAmt: 100.01 });
  });
});

describe('MemberBalanceTransferService post', () => {
  it('recomputes amounts from the ledger instead of trusting the client values', async () => {
    const { service, qr, calls } = build({
      balances: { '1001': { L1001: { dr: 0, cr: 250 }, A3001: { dr: 0, cr: 0 } } },
    });

    const result = await service.post(
      [{ srNo: 1, mbno: '1001', name: 'stale', dbHeadBal: 999999, crHeadBal: 0, dbAmt: 999999, crAmt: 999999, exCrAmt: 0 }],
      'L1001', 'A3001', 'A2001', 'clerk', 200, '2026-09-30',
    );

    expect(result.success).toBe(true);
    expect(result.voucherNo).toBe('J00001');

    const ledgerInserts = calls.filter(({ sql }) => sql.includes('INSERT INTO ledger'));
    expect(ledgerInserts.map(({ params }) => params?.[3])).toEqual([250, 200, 50]);
    // the direction is written in the SQL ('DR' / 'CR'), the head, member, amount and voucher are parameters
    expect(ledgerInserts[0].sql).toContain("'DR'");
    expect(ledgerInserts[0].params).toEqual(expect.arrayContaining(['L1001', '1001', 250, 'J00001']));
    expect(ledgerInserts[2].sql).toContain("'CR'");
    expect(ledgerInserts[2].params).toEqual(expect.arrayContaining(['A2001', 50]));

    expect(calls.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('refuses to post when part of a balance is above the credit limit and no excess head is chosen (ES-421)', async () => {
    const { service, qr, calls } = build({ balances: { '1001': { L1001: { dr: 0, cr: 250 } } } });
    await expect(service.post(
      [{ srNo: 1, mbno: '1001', name: '', dbHeadBal: 0, crHeadBal: 0, dbAmt: 0, crAmt: 0, exCrAmt: 0 }],
      'L1001', 'A3001', '', 'clerk', 200, '2026-09-30',
    )).rejects.toThrow(/Choose an excess head/);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO ledger'))).toBe(false);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.commitTransaction).not.toHaveBeenCalled();
  });

  it('every posted voucher balances: the debit equals the credit plus the excess', async () => {
    const { service, calls } = build({ balances: { '1001': { L1001: { dr: 0, cr: 250 } } } });
    await service.post(
      [{ srNo: 1, mbno: '1001', name: '', dbHeadBal: 0, crHeadBal: 0, dbAmt: 0, crAmt: 0, exCrAmt: 0 }],
      'L1001', 'A3001', 'A2001', 'clerk', 200, '2026-09-30',
    );
    const legs = calls.filter(({ sql }) => sql.includes('INSERT INTO ledger')).map(({ sql, params }) => ({ dr: /'DR'/.test(sql), amt: params?.[3] }));
    const dr = legs.filter((l) => l.dr).reduce((t, l) => t + l.amt, 0);
    const cr = legs.filter((l) => !l.dr).reduce((t, l) => t + l.amt, 0);
    expect(dr).toBe(250); expect(cr).toBe(250);
  });

  it('skips the credit leg when the limit is zero and posts only the excess', async () => {
    const { service, calls } = build({
      balances: { '1001': { L1001: { dr: 0, cr: 80 } } },
    });

    await service.post(
      [{ srNo: 1, mbno: '1001', name: '', dbHeadBal: 0, crHeadBal: 0, dbAmt: 0, crAmt: 0, exCrAmt: 0 }],
      'L1001', 'A3001', 'A2001', 'clerk', 0, '2026-09-30',
    );

    const ledgerInserts = calls.filter(({ sql }) => sql.includes('INSERT INTO ledger'));
    expect(ledgerInserts.map(({ params }) => params?.[3])).toEqual([80, 80]);
    expect(ledgerInserts[1].params).toContain('A2001');
  });

  it('rolls back and wraps a database failure', async () => {
    const { service, qr } = build({
      balances: { '1001': { L1001: { dr: 0, cr: 80 } } },
    });
    qr.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO ledger')) throw new Error('insert failed');
      if (sql.includes('pflag FROM headmaster')) return [{ pflag: 'L' }];
      if (sql.includes('FROM fundsmaster f') || sql.includes('SELECT mbno::text as mbno, TRIM')) return [{ mbno: '1001', name: 'A' }];
      if (sql.includes('FROM ledger WHERE code = $1')) return [{ dr: 0, cr: 80 }];
      if (sql.includes('MAX(')) return [{ max_id: '0', max_no: '0' }];
      if (sql.includes('j_vchr_no')) return [{ last: 'J00000' }];
      return [];
    });

    await expect(service.post(
      [{ srNo: 1, mbno: '1001', name: '', dbHeadBal: 0, crHeadBal: 0, dbAmt: 0, crAmt: 0, exCrAmt: 0 }],
      'L1001', 'A3001', '', 'clerk', 1000, '2026-09-30',
    )).rejects.toThrow(/Failed to post member balance transfer/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });
});
