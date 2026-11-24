import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { UtilitiesService } from '../../../src/modules/utilities/utilities.service';

// Head Addition / Modification (ES-636): save and delete rules of the chart of accounts.

type Call = { sql: string; params?: any[] };

interface Opts {
  heads?: Record<string, { parent: string; type?: string; pflag?: string }>;
  ledgerRows?: number;
  voucherLines?: number;
  children?: number;
}

const build = (o: Opts = {}) => {
  const heads = o.heads ?? {
    M1000: { parent: 'ROOT', pflag: 'R' },
    L1000: { parent: 'M1000', pflag: 'R' },
    L1005: { parent: 'L1000' },
    L1006: { parent: 'L1005' },
    A1000: { parent: 'M1000', pflag: 'R' },
    A1001: { parent: 'A1000', type: 'CINH' },
    A1008: { parent: 'A1007', type: 'BANK' },
    A1007: { parent: 'A1000' },
  };
  const calls: Call[] = [];
  const answer = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    const code = String(params?.[0] ?? '');
    if (sql.includes('SELECT parent_code, headtype FROM headmaster WHERE code = $1')) return heads[code] ? [{ parent_code: heads[code]!.parent, headtype: heads[code]!.type ?? 'OTH' }] : [];
    if (sql.includes('SELECT 1 FROM headmaster WHERE code = $1')) return heads[code] ? [{ 1: 1 }] : [];
    if (sql.includes('WITH RECURSIVE up')) {
      // does walking up from parent ($1) reach the head being saved ($2)?
      let cur: string | undefined = String(params?.[0]);
      for (let i = 0; i < 50 && cur && heads[cur]; i++) { if (cur === params?.[1]) return [{ 1: 1 }]; cur = heads[cur]!.parent; }
      return [];
    }
    if (sql.includes('SELECT code FROM headmaster WHERE code = $1')) return heads[code] ? [{ code }] : [];
    if (sql.includes('COUNT(*)::int AS cnt FROM headmaster WHERE parent_code')) return [{ cnt: o.children ?? Object.values(heads).filter(h => h.parent === code).length }];
    if (sql.includes('COUNT(*)::int AS cnt FROM ledger')) return [{ cnt: o.ledgerRows ?? 0 }];
    if (sql.includes('COUNT(*)::int AS cnt FROM transactions')) return [{ cnt: o.voucherLines ?? 0 }];
    if (sql.includes('SELECT headtype, pflag FROM headmaster')) return heads[code] ? [{ headtype: heads[code]!.type ?? 'OTH', pflag: heads[code]!.pflag ?? 'L' }] : [];
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
  return { svc: new UtilitiesService(ds, {} as any, {} as any), qr, calls };
};

const write = (calls: Call[], verb: 'INSERT' | 'UPDATE') => calls.filter(c => c.sql.includes(`${verb} headmaster`) || c.sql.includes(`${verb} INTO headmaster`));
const good = (over: any = {}) => ({ code: 'L1010', parentCode: 'L1005', headName: 'New fund', pflag: 'L', headType: 'OTH', interest: 'N', opBal: 0, isNew: true, ...over });

describe('saveHeadMaster', () => {
  it('adds a head and writes one INSERT', async () => {
    const { svc, calls, qr } = build();
    const r = await svc.saveHeadMaster(good());
    expect(r.success).toBe(true);
    expect(write(calls, 'INSERT')).toHaveLength(1);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('writes the code in capitals, so l1010 and L1010 are one head', async () => {
    const { svc, calls } = build();
    await svc.saveHeadMaster(good({ code: 'l1010', parentCode: 'l1005', pflag: 'l' }));
    const ins = write(calls, 'INSERT')[0]!;
    expect(ins.params![0]).toBe('L1010');
    expect(ins.params![1]).toBe('L1005');
  });

  it('Add never overwrites an existing head (409), nothing is written', async () => {
    const { svc, calls } = build();
    await expect(svc.saveHeadMaster(good({ code: 'L1006' }))).rejects.toBeInstanceOf(ConflictException);
    expect(write(calls, 'INSERT')).toHaveLength(0);
    expect(write(calls, 'UPDATE')).toHaveLength(0);
  });

  it('Edit of an existing head updates it', async () => {
    const { svc, calls } = build();
    await svc.saveHeadMaster(good({ code: 'L1006', parentCode: 'L1005', isNew: false, headName: 'RENAMED' }));
    expect(write(calls, 'UPDATE')).toHaveLength(1);
  });

  it.each([
    ['empty code', { code: '' }, /1 to 5/],
    ['code too long', { code: 'L10100' }, /1 to 5/],
    ['code with a space', { code: 'L1 01' }, /1 to 5/],
    ['empty name', { headName: '  ' }, /Head name is required/],
    ['name over 100', { headName: 'x'.repeat(101) }, /at most 100/],
    ['opening balance not a number', { opBal: 'abc' }, /Opening balance/],
    ['bad section flag', { pflag: 'Z' }, /P Flag must be/],
    ['bad interest', { interest: 'maybe' }, /Interest must be/],
    ['no parent', { parentCode: '' }, /Parent head code is required/],
    ['own parent', { code: 'L1010', parentCode: 'L1010' }, /own parent/],
    ['parent does not exist', { parentCode: 'L9999' }, /does not exist/],
    ['code letter differs from the parent section', { code: 'A1010', parentCode: 'L1005', pflag: 'A' }, /must start with L/],
    ['head type too long', { headType: 'TOOLONG' }, /at most 4/],
  ])('refuses %s with a 400', async (_n, patch, text) => {
    const { svc, calls } = build();
    const p = svc.saveHeadMaster(good(patch as any));
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow(text as RegExp);
    expect(write(calls, 'INSERT')).toHaveLength(0);
  });

  it('refuses to move a head under its own child (a loop)', async () => {
    const { svc, calls } = build();
    await expect(svc.saveHeadMaster(good({ code: 'L1005', parentCode: 'L1006', isNew: false }))).rejects.toThrow(/below L1005/);
    expect(write(calls, 'UPDATE')).toHaveLength(0);
  });

  it('keeps the existing head type on an edit that sends none, and defaults a new head to OTH', async () => {
    const a = build();
    await a.svc.saveHeadMaster(good({ code: 'A1001', parentCode: 'A1000', pflag: 'A', headType: '', isNew: false }));
    expect(write(a.calls, 'UPDATE')[0]!.params![2]).toBe('CINH');
    const b = build();
    await b.svc.saveHeadMaster(good({ headType: '' }));
    expect(write(b.calls, 'INSERT')[0]!.params![3]).toBe('OTH');
  });

  it('takes the section flag from the code letter when none is sent', async () => {
    const { svc, calls } = build();
    await svc.saveHeadMaster(good({ pflag: '' }));
    expect(write(calls, 'INSERT')[0]!.params![6]).toBe('L');
  });

  it('a failed write is rolled back and released', async () => {
    const { svc, qr } = build();
    const orig = qr.query.getMockImplementation();
    qr.query.mockImplementation(async (sql: string, p: any[]) => { if (sql.includes('INSERT INTO headmaster')) throw new Error('boom'); return orig(sql, p); });
    await expect(svc.saveHeadMaster(good())).rejects.toThrow(/Failed to save head: boom/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });

  it('two people adding the same code at once: the loser gets 409, not a 500', async () => {
    const { svc, qr } = build();
    const orig = qr.query.getMockImplementation();
    qr.query.mockImplementation(async (sql: string, p: any[]) => { if (sql.includes('INSERT INTO headmaster')) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }); return orig(sql, p); });
    await expect(svc.saveHeadMaster(good())).rejects.toBeInstanceOf(ConflictException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('stress: 200 different heads saved at once all succeed', async () => {
    const { svc, calls } = build();
    const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => svc.saveHeadMaster(good({ code: `L${2000 + i}` }))));
    expect(rs.every(r => r.success)).toBe(true);
    expect(write(calls, 'INSERT')).toHaveLength(200);
  });
});

describe('deleteHeadMaster', () => {
  it('deletes a plain head (and its balance snapshot row)', async () => {
    const { svc, calls, qr } = build();
    const r = await svc.deleteHeadMaster('L1006');
    expect(r.success).toBe(true);
    expect(calls.some(c => c.sql.includes('DELETE FROM headmaster'))).toBe(true);
    expect(calls.some(c => c.sql.includes('DELETE FROM balancesheet'))).toBe(true);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('unknown head is 404', async () => {
    const { svc } = build();
    await expect(svc.deleteHeadMaster('L9999')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a head with children is refused', async () => {
    const { svc, calls } = build();
    await expect(svc.deleteHeadMaster('L1005')).rejects.toThrow(/child heads/);
    expect(calls.some(c => c.sql.includes('DELETE FROM headmaster'))).toBe(false);
  });

  it('a head with ledger postings is refused', async () => {
    const { svc, calls } = build({ ledgerRows: 4 });
    await expect(svc.deleteHeadMaster('L1006')).rejects.toThrow(/4 ledger transaction/);
    expect(calls.some(c => c.sql.includes('DELETE FROM headmaster'))).toBe(false);
  });

  it('a head used by a waiting voucher is refused', async () => {
    const { svc, calls } = build({ voucherLines: 2 });
    await expect(svc.deleteHeadMaster('L1006')).rejects.toThrow(/2 voucher line/);
    expect(calls.some(c => c.sql.includes('DELETE FROM headmaster'))).toBe(false);
  });

  it('section heads and system heads (cash, loan, share ...) are refused', async () => {
    const { svc } = build({ children: 0 });
    await expect(svc.deleteHeadMaster('L1000')).rejects.toThrow(/section head/);
    await expect(svc.deleteHeadMaster('A1001')).rejects.toThrow(/system head \(CINH\)/);
  });

  it('a bank head with no postings can be deleted', async () => {
    const { svc } = build({ children: 0 });
    await expect(svc.deleteHeadMaster('A1008')).resolves.toMatchObject({ success: true });
  });

  it('a refusal rolls back and releases', async () => {
    const { svc, qr } = build({ ledgerRows: 1 });
    await expect(svc.deleteHeadMaster('L1006')).rejects.toBeInstanceOf(ConflictException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });
});

describe('head list response shape (ES-636)', () => {
  it('the controller returns the list itself, not { success, data } (the global wrapper adds that)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../../src/modules/utilities/utilities.controller.ts'), 'utf8');
    const block = src.slice(src.indexOf("@Get('head-master')"), src.indexOf("@Get('divisions')"));
    expect(block).toContain('return this.utilitiesService.getHeadMaster();');
    expect(block).not.toMatch(/return \{ success: true, data \}/);
  });
});
