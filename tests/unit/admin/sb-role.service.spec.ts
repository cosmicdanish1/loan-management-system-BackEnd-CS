import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SbAccountService } from '../../../src/modules/admin/services/sb-account.service';
import { RoleManagementService } from '../../../src/modules/admin/services/role-management.service';

function mkSb(over: { dup?: any[]; member?: any[]; ledgerHistory?: any[]; found?: any } = {}) {
  const qr: any = {
    connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      if (/CREATE TABLE/.test(sql)) return [];
      if (/SELECT 1 FROM sbmaster/.test(sql)) return over.dup ?? [];
      if (/SELECT 1 FROM member_master/.test(sql)) return over.member ?? [{ 1: 1 }];
      if (/FROM voucher_master/.test(sql)) return [{ last: 'R00001' }];
      if (/SELECT 1 WHERE EXISTS/.test(sql)) return [];
      if (/MAX\(trans_no\)/.test(sql)) return [{ next_trans_no: 10, next_ledger_id: 20 }];
      if (/INSERT INTO sbmaster/.test(sql)) return [{ acc_no: 'x' }];
      return [];
    }),
  };
  const ds: any = { createQueryRunner: jest.fn(() => qr) };
  const repo: any = {
    query: jest.fn(async (sql: string) => (/FROM ledger/.test(sql) ? over.ledgerHistory ?? [] : /MAX\(acc_no/.test(sql) ? [{ next: '101' }] : [])),
    findOne: jest.fn().mockResolvedValue(over.found ?? null), find: jest.fn().mockResolvedValue([]), delete: jest.fn(), save: jest.fn(async (x) => x),
    merge: jest.fn((a, b) => Object.assign(a, b)),
  };
  return { svc: new SbAccountService(repo, ds), qr, repo };
}
const dto = (o: any = {}) => ({ accountNo: '101', memberNo: 5, openingBalance: 1000, ...o }) as any;
const sqls = (qr: any) => qr.query.mock.calls.map((c: any[]) => c[0]).join('\n');

describe('admin/SbAccountService', () => {
  it('next account number = max numeric account + 1', async () => { expect(await mkSb().svc.getNextAccountNumber()).toEqual({ nextAccountNumber: '101' }); });
  it('409 for a duplicate account number and rolls back', async () => {
    const { svc, qr } = mkSb({ dup: [{}] });
    await expect(svc.create(dto())).rejects.toThrow(ConflictException);
    expect(qr.rollbackTransaction).toHaveBeenCalled(); expect(qr.release).toHaveBeenCalled();
  });
  it('404 for an unknown member', async () => {
    await expect(mkSb({ member: [] }).svc.create(dto())).rejects.toThrow(NotFoundException);
  });
  it('rejects a negative opening balance', async () => {
    await expect(mkSb().svc.create(dto({ openingBalance: -1 }))).rejects.toThrow(BadRequestException);
  });
  it('rejects a non numeric opening balance instead of treating it as zero', async () => {
    await expect(mkSb().svc.create(dto({ openingBalance: 'abc' }))).rejects.toThrow(BadRequestException);
  });
  it('rejects an absurd opening balance (1e12)', async () => {
    await expect(mkSb().svc.create(dto({ openingBalance: 1e12 }))).rejects.toThrow(BadRequestException);
  });
  it('zero opening balance posts nothing to the ledger', async () => {
    const { svc, qr } = mkSb(); await svc.create(dto({ openingBalance: 0 }));
    expect(sqls(qr)).not.toContain('INSERT INTO ledger');
  });
  it('an opening balance posts two balanced ledger lines with the same voucher', async () => {
    const { svc, qr } = mkSb(); await svc.create(dto({ openingBalance: 2500 }));
    const ledger = qr.query.mock.calls.filter((c: any[]) => /INSERT INTO ledger/.test(c[0]));
    expect(ledger).toHaveLength(2);
    expect(ledger[0][1][4]).toBe(2500); expect(ledger[1][1][3]).toBe(2500);
    expect(ledger[0][1][5]).toBe(ledger[1][1][4]);
    expect(ledger[0][0]).toContain("'CR'"); expect(ledger[1][0]).toContain("'DR'");
  });
  it('the whole creation commits in one transaction', async () => {
    const { svc, qr } = mkSb(); await svc.create(dto());
    expect(qr.commitTransaction).toHaveBeenCalledTimes(1); expect(qr.release).toHaveBeenCalled();
  });
  it('findOne 404', async () => { await expect(mkSb().svc.findOne('9')).rejects.toThrow(NotFoundException); });
  it('remove refuses an account with ledger history', async () => {
    const { svc, repo } = mkSb({ found: { accountNo: '1' }, ledgerHistory: [{}] });
    await expect(svc.remove('1')).rejects.toThrow(ConflictException); expect(repo.delete).not.toHaveBeenCalled();
  });
  it('remove deletes an unused account', async () => {
    const { svc, repo } = mkSb({ found: { accountNo: '1' } }); await svc.remove('1');
    expect(repo.delete).toHaveBeenCalledWith('1');
  });
  it('update keeps the opening date when none is supplied', async () => {
    const d = new Date('2020-01-01'); const { svc } = mkSb({ found: { accountNo: '1', openingDate: d } });
    expect((await svc.update('1', { nomineeName: 'X' } as any)).openingDate).toBe(d);
  });
});

describe('admin/RoleManagementService', () => {
  function mkRole(level: any = { userlevelid: 5 }) {
    const em: any = { delete: jest.fn(), create: jest.fn((_e, x) => x), save: jest.fn() };
    const ds: any = { transaction: jest.fn(async (fn: any) => fn(em)) };
    const levelRepo: any = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(level), create: jest.fn((x) => x), save: jest.fn() };
    const menuRepo: any = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => x), save: jest.fn() };
    const rights: any = { find: jest.fn().mockResolvedValue([{ menuid: 3 }, { menuid: 9 }]) };
    return { svc: new RoleManagementService(levelRepo, menuRepo, rights, ds), em, ds, levelRepo, menuRepo, rights };
  }
  it('getDefaultRights returns the menu ids', async () => { expect(await mkRole().svc.getDefaultRights(5)).toEqual([3, 9]); });
  it('findAllUserLevels sorted by id', async () => {
    const { svc, levelRepo } = mkRole(); await svc.findAllUserLevels();
    expect(levelRepo.find).toHaveBeenCalledWith({ order: { userlevelid: 'ASC' } });
  });
  it('updateDefaultRights 404 for an unknown level', async () => {
    await expect(mkRole(null).svc.updateDefaultRights({ userlevelid: 99, menuIds: [1] })).rejects.toThrow(NotFoundException);
  });
  it('replaces the rights in one transaction (delete then save)', async () => {
    const { svc, em, ds } = mkRole();
    expect(await svc.updateDefaultRights({ userlevelid: 5, menuIds: [1, 2] })).toEqual({ message: 'Default rights updated successfully', userlevelid: 5, count: 2 });
    expect(ds.transaction).toHaveBeenCalledTimes(1);
    expect(em.delete).toHaveBeenCalled(); expect(em.save.mock.calls[0][1]).toEqual([{ userlevelid: 5, menuid: 1 }, { userlevelid: 5, menuid: 2 }]);
  });
  it('an empty list clears the rights without saving', async () => {
    const { svc, em } = mkRole(); await svc.updateDefaultRights({ userlevelid: 5, menuIds: [] });
    expect(em.delete).toHaveBeenCalled(); expect(em.save).not.toHaveBeenCalled();
  });
  it('duplicate menu ids in the request are stored once', async () => {
    const { svc, em } = mkRole(); await svc.updateDefaultRights({ userlevelid: 5, menuIds: [1, 1, 2] });
    expect(em.save.mock.calls[0][1]).toHaveLength(2);
  });
  it('a missing menuIds list is answered with a clean 400, not a crash', async () => {
    await expect(mkRole().svc.updateDefaultRights({ userlevelid: 5 } as any)).rejects.toThrow(BadRequestException);
  });
});
