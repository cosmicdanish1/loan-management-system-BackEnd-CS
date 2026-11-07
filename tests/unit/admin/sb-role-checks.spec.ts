import { BadRequestException } from '@nestjs/common';
import { SbAccountService } from '../../../src/modules/admin/services/sb-account.service';
import { RoleManagementService } from '../../../src/modules/admin/services/role-management.service';

function mkSb() {
  const qr: any = {
    connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      if (/CREATE TABLE/.test(sql)) return [];
      if (/SELECT 1 FROM sbmaster/.test(sql)) return [];
      if (/SELECT 1 FROM member_master/.test(sql)) return [{ 1: 1 }];
      if (/FROM voucher_master/.test(sql)) return [{ last: 'R00001' }];
      if (/SELECT 1 WHERE EXISTS/.test(sql)) return [];
      if (/MAX\(trans_no\)/.test(sql)) return [{ next_trans_no: 10, next_ledger_id: 20 }];
      if (/INSERT INTO sbmaster/.test(sql)) return [{ acc_no: 'x' }];
      return [];
    }),
  };
  const ds: any = { createQueryRunner: jest.fn(() => qr) };
  const repo: any = {
    query: jest.fn(async (sql: string) => (/MAX\(acc_no/.test(sql) ? [{ next: '101' }] : [])),
    findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]), delete: jest.fn(), save: jest.fn(async (x) => x),
    merge: jest.fn((a, b) => Object.assign(a, b)),
  };
  return { svc: new SbAccountService(repo, ds), qr };
}
const dto = (o: any = {}) => ({ accountNo: '101', memberNo: 5, openingBalance: 1000, ...o }) as any;
const sqls = (qr: any) => qr.query.mock.calls.map((c: any[]) => c[0]).join('\n');

describe('admin/SbAccountService opening balance checks (ES-302)', () => {
  it('a numeric string is accepted as a number', async () => {
    const { svc, qr } = mkSb();
    await svc.create(dto({ openingBalance: '2500' }));
    expect(sqls(qr)).toContain('INSERT INTO ledger');
  });
  it('a missing, null or empty opening balance means zero and still opens the account', async () => {
    for (const v of [undefined, null, '']) {
      const { svc, qr } = mkSb();
      await svc.create(dto({ openingBalance: v }));
      expect(sqls(qr)).not.toContain('INSERT INTO ledger');
    }
  });
  it('NaN, Infinity, objects and arrays are refused', async () => {
    for (const v of [NaN, Infinity, -Infinity, {}, [1, 2]]) {
      await expect(mkSb().svc.create(dto({ openingBalance: v }))).rejects.toThrow(BadRequestException);
    }
  });
  it('the largest allowed amount works, one rupee above is refused, and nothing is posted when refused', async () => {
    await expect(mkSb().svc.create(dto({ openingBalance: 1_000_000_000 }))).resolves.toBeDefined();
    const { svc, qr } = mkSb();
    await expect(svc.create(dto({ openingBalance: 1_000_000_001 }))).rejects.toThrow(/too large/);
    expect(sqls(qr)).not.toContain('INSERT INTO ledger');
  });
});

function mkRole() {
  const em: any = { delete: jest.fn(), create: jest.fn((_e, x) => x), save: jest.fn() };
  const ds: any = { transaction: jest.fn(async (fn: any) => fn(em)) };
  const levelRepo: any = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue({ userlevelid: 5 }), create: jest.fn((x) => x), save: jest.fn() };
  const menuRepo: any = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => x), save: jest.fn() };
  const rights: any = { find: jest.fn().mockResolvedValue([]) };
  return { svc: new RoleManagementService(levelRepo, menuRepo, rights, ds), em };
}

describe('admin/RoleManagementService menu list checks (ES-302)', () => {
  it('a list that is not an array, or has non-integers / negatives, is a 400 and nothing is deleted', async () => {
    for (const bad of ['1,2', { 0: 1 }, [1, 'x'], [1.5], [-1], [null]]) {
      const { svc, em } = mkRole();
      await expect(svc.updateDefaultRights({ userlevelid: 5, menuIds: bad as any })).rejects.toThrow(BadRequestException);
      expect(em.delete).not.toHaveBeenCalled();
    }
  });
  it('the reply counts the menus actually stored (duplicates removed)', async () => {
    const { svc } = mkRole();
    expect((await svc.updateDefaultRights({ userlevelid: 5, menuIds: [4, 4, 4, 7] })).count).toBe(2);
  });
  it('the order of first appearance is kept', async () => {
    const { svc, em } = mkRole();
    await svc.updateDefaultRights({ userlevelid: 5, menuIds: [9, 3, 9, 3, 1] });
    expect(em.save.mock.calls[0][1].map((r: any) => r.menuid)).toEqual([9, 3, 1]);
  });
});
