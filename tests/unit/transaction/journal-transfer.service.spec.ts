import { BadRequestException } from '@nestjs/common';
import { JournalTransferService } from '../../../src/modules/transaction/services-v2/journal-transfer.service';

const dto = (rows: any[], over: Partial<Record<string, any>> = {}): any => ({
  transferType: 'headToHead', narration: 'test', rows, ...over,
});

const build = (opts: { heads?: string[]; members?: number[]; fail?: string } = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/j_vchr_no/.test(sql)) return [{ last: 'J00004' }];
      if (/^SELECT 1 WHERE EXISTS/.test(sql.trim())) return [];
      if (/pg_advisory_xact_lock/.test(sql)) return [];
      if (/MAX\(id\)/.test(sql)) return [{ next_id: '3' }];
      if (/MAX\(trans_no\)/.test(sql)) return [{ next_id: '10' }];
      if (/SELECT code FROM headmaster/.test(sql)) {
        return (params?.[0] || []).filter((c: string) => (opts.heads ?? ['A1001', 'L1001']).includes(c)).map((c: string) => ({ code: c }));
      }
      if (/SELECT mbno FROM member_master/.test(sql)) {
        return (params?.[0] || []).filter((m: number) => (opts.members ?? [1001]).includes(Number(m))).map((m: number) => ({ mbno: m }));
      }
      if (opts.fail && sql.includes(opts.fail)) throw new Error('db down');
      return [];
    }),
  };
  const dataSource: any = { createQueryRunner: jest.fn().mockReturnValue(qr) };
  const service = new JournalTransferService(dataSource);
  return { service, qr, dataSource, calls };
};

describe('JournalTransferService validation', () => {
  it.each([
    ['no rows', [], /at least two rows/],
    ['unbalanced', [{ code: 'A1001', debit: 10, credit: 0 }, { code: 'L1001', debit: 0, credit: 5 }], /Unbalanced/],
    ['zero total', [{ code: 'A1001', debit: 0, credit: 0 }, { code: 'L1001', debit: 0, credit: 0 }], /greater than zero|two rows/],
    ['negative amount', [{ code: 'A1001', debit: -10, credit: 0 }, { code: 'L1001', debit: 0, credit: -10 }], /cannot be negative|greater than zero/],
    ['debit and credit on one row', [
      { code: 'A1001', debit: 10, credit: 10 }, { code: 'L1001', debit: 10, credit: 0 }, { code: 'L1001', debit: 0, credit: 10 },
    ], /both a debit and a credit/],
    ['missing head code', [{ code: '', debit: 10, credit: 0 }, { code: 'L1001', debit: 0, credit: 10 }], /head code/],
    ['same account', [{ code: 'A1001', mbno: 1001, debit: 10, credit: 0 }, { code: 'A1001', mbno: 1001, debit: 0, credit: 10 }], /same account/],
  ])('rejects %s without opening a transaction', async (_label, rows, message) => {
    const { service, dataSource } = build();
    await expect(service.postJournalEntry(dto(rows as any[]))).rejects.toThrow(message as RegExp);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});

describe('JournalTransferService posting', () => {
  it('rejects a head code that is not in headmaster and rolls back', async () => {
    const { service, qr } = build({ heads: ['A1001'] });
    await expect(service.postJournalEntry(dto([
      { code: 'A1001', debit: 10, credit: 0 }, { code: 'ZZ999', debit: 0, credit: 10 },
    ]))).rejects.toBeInstanceOf(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });

  it('rejects an unknown member number', async () => {
    const { service } = build({ members: [1001] });
    await expect(service.postJournalEntry(dto([
      { code: 'A1001', mbno: 9999, debit: 10, credit: 0 },
      { code: 'L1001', mbno: 1001, debit: 0, credit: 10 },
    ]))).rejects.toThrow(/Unknown member/);
  });

  it('creates a PENDING voucher and stages every row with pass_flag N', async () => {
    const { service, qr, calls } = build({ heads: ['A1001', 'A1047'] });

    const result = await service.postJournalEntry(dto([
      { code: 'a1001', mbno: 1001, debit: 25, credit: 0, narration: 'from savings' },
      { code: 'A1047', mbno: 1001, debit: 0, credit: 25 },
    ]), 'clerk');

    expect(result).toEqual({
      success: true,
      message: 'Journal voucher J00005 created. Go to Pass Transactions to post.',
      voucherNo: 'J00005',
    });

    const header = calls.find(({ sql }) => sql.includes('INSERT INTO vouchers'));
    expect(header?.sql).toContain("'PENDING'");
    expect(header?.params).toEqual(expect.arrayContaining([3, 'J00005', 25, 'test', 1001]));

    const staged = calls.filter(({ sql }) => sql.includes('INSERT INTO transactions'));
    expect(staged).toHaveLength(2);
    expect(staged[0].params).toEqual(expect.arrayContaining([10, 'DR', 1001, 25, 'J00005', 'A1001', 'clerk']));
    expect(staged[1].params).toEqual(expect.arrayContaining([11, 'CR', 1001, 25, 'J00005', 'A1047']));
    // acc_type is carried per row so the member ledger sees the loan head
    expect(staged[0].params).toContain('JV');
    expect(staged[1].params).toContain('ALN');

    // advisory locks guard both id reads
    const locks = calls.filter(({ sql }) => sql.includes('pg_advisory_xact_lock'));
    expect(locks.length).toBeGreaterThanOrEqual(2);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('uses RLN for the regular-loan head', async () => {
    const { service, calls } = build({ heads: ['A1002', 'A1001'] });
    await service.postJournalEntry(dto([
      { code: 'A1002', debit: 10, credit: 0 }, { code: 'A1001', debit: 0, credit: 10 },
    ]));
    const staged = calls.filter(({ sql }) => sql.includes('INSERT INTO transactions'));
    expect(staged[0].params).toContain('RLN');
  });
});
