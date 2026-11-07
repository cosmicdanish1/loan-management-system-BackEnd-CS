import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserManagementService } from '../../../src/modules/admin/services/user-management.service';
import { OfficeService } from '../../../src/modules/admin/services/office.service';
import { WingService } from '../../../src/modules/admin/services/wing.service';
import { DesignationService } from '../../../src/modules/admin/services/designation.service';
import { CastCategoryService } from '../../../src/modules/admin/services/cast-category.service';
import { MemberFundsService } from '../../../src/modules/admin/services/member-funds.service';
import { MemberBalanceService } from '../../../src/modules/admin/services/member-balance.service';

const userRow = (o: any = {}) => ({
  userid: 7, susername: 'bob', userLevel: { userlevel: 'CLERK', userlevelid: 6 }, userlevelid: 6, enableDisable: 'E', email: 'b@x.com', firstName: 'B', lastName: 'C',
  hasExplicitPermissions: false, permissions: [], isEnabled: true, canPassTransactions: true, fullName: 'B C', dateOfCreation: new Date(), forceLogoutAt: null,
  validatePassword: jest.fn().mockResolvedValue(true), ...o,
});
const admin = (o: any = {}) => userRow({ userLevel: { userlevel: 'ADMINISTRATOR', userlevelid: 1 }, userlevelid: 1, ...o });

function mkUsers(adminCount: number) {
  const qb: any = {
    where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(), leftJoinAndSelect: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(adminCount), getOne: jest.fn().mockResolvedValue({ userlevelid: 6, userlevel: 'CLERK' }),
  };
  const um: any = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]), save: jest.fn(async (x) => x), remove: jest.fn(), query: jest.fn().mockResolvedValue([]), createQueryBuilder: jest.fn(() => qb) };
  const levelRepo: any = { createQueryBuilder: jest.fn(() => qb), find: jest.fn().mockResolvedValue([]), create: jest.fn((x) => x), save: jest.fn() };
  const loginRepo: any = { find: jest.fn().mockResolvedValue([]), save: jest.fn() };
  const actRepo: any = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
  return { svc: new UserManagementService(actRepo, um, levelRepo, loginRepo, {} as any), um };
}

describe('admin/UserManagementService last administrator through update (ES-400)', () => {
  it('the only enabled administrator cannot be demoted or disabled', async () => {
    for (const dto of [{ role: 'clerk' }, { isActive: false }, { role: 'clerk', isActive: false }]) {
      const { svc, um } = mkUsers(1); um.findOne.mockResolvedValue(admin());
      await expect(svc.updateUser(7, dto as any, 99)).rejects.toThrow(ForbiddenException);
      expect(um.save).not.toHaveBeenCalled();
    }
  });
  it('with a second administrator the first can be demoted or disabled', async () => {
    for (const dto of [{ role: 'clerk' }, { isActive: false }]) {
      const { svc, um } = mkUsers(2); um.findOne.mockResolvedValue(admin());
      await expect(svc.updateUser(7, dto as any, 99)).resolves.toBeDefined();
    }
  });
  it('the only administrator can still be edited in other ways (name, e-mail, keeping the role, staying enabled)', async () => {
    for (const dto of [{ firstName: 'X' }, { email: 'new@x.com' }, { role: 'administrator' }, { isActive: true }]) {
      const { svc, um } = mkUsers(1); um.findOne.mockResolvedValueOnce(admin()).mockResolvedValue(null);
      await expect(svc.updateUser(7, dto as any, 99)).resolves.toBeDefined();
    }
  });
  it('a non-administrator, or an administrator who is already disabled, can be disabled / changed freely', async () => {
    const a = mkUsers(1); a.um.findOne.mockResolvedValue(userRow());
    await expect(a.svc.updateUser(7, { isActive: false } as any, 99)).resolves.toBeDefined();
    const b = mkUsers(1); b.um.findOne.mockResolvedValue(admin({ enableDisable: 'D' }));
    await expect(b.svc.updateUser(7, { role: 'clerk' } as any, 99)).resolves.toBeDefined();
  });
});

describe('admin/UserManagementService delete and force logout (ES-258, ES-400)', () => {
  it('nobody can delete their own account, even when other administrators exist', async () => {
    const { svc, um } = mkUsers(3); um.findOne.mockResolvedValue(admin());
    await expect(svc.deleteUser(7, 7)).rejects.toThrow(/your own account/);
    expect(um.remove).not.toHaveBeenCalled();
  });
  it('deleting someone else still works, and so does a call that has no actor id', async () => {
    const a = mkUsers(3); a.um.findOne.mockResolvedValue(userRow());
    await expect(a.svc.deleteUser(7, 1)).resolves.toEqual({ message: 'User deleted successfully' });
    const b = mkUsers(3); b.um.findOne.mockResolvedValue(userRow());
    await expect(b.svc.deleteUser(7)).resolves.toBeDefined();
    const c = mkUsers(3); c.um.findOne.mockResolvedValue(userRow());
    await expect(c.svc.deleteUser(7, NaN)).resolves.toBeDefined();
  });
  it('force logout matches the name literally: % _ and \\ are escaped', async () => {
    const lookup = async (name: string) => {
      const { svc, um } = mkUsers(2); um.findOne.mockResolvedValue(null);
      await svc.forceLogoutUser(name).catch(() => undefined);
      return um.findOne.mock.calls[0][0].where.susername.value;
    };
    expect(await lookup('%')).toBe('\\%');
    expect(await lookup('a_b')).toBe('a\\_b');
    expect(await lookup('a\\b')).toBe('a\\\\b');
    expect(await lookup('  Bob ')).toBe('Bob');
  });
  it('force logout of a normal name still works', async () => {
    const { svc, um } = mkUsers(2); const u: any = userRow(); um.findOne.mockResolvedValue(u);
    await svc.forceLogoutUser('bob');
    expect(u.loginStatus).toBe('N');
  });
});

const repo = (o: any = {}) => ({
  find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => ({ ...x })),
  save: jest.fn(async (x) => x), delete: jest.fn().mockResolvedValue({ affected: 1 }), ...o,
}) as any;
const ds = (n: number) => ({ query: jest.fn().mockResolvedValue([{ n }]) }) as any;

describe('admin masters: a duplicate key is refused, nothing is overwritten (ES-299)', () => {
  it('office / wing / designation / cast category: a new key is saved, an existing key is a 409 and is not saved', async () => {
    const cases: Array<[string, () => { create: () => Promise<any>; r: any }]> = [
      ['office', () => { const r = repo(); return { r, create: () => new OfficeService(r, ds(0)).create({ officeId: 5, name: 'X' } as any) }; }],
      ['wing', () => { const r = repo(); return { r, create: () => new WingService(r, ds(0)).create({ wingId: '1', name: 'X' } as any) }; }],
      ['designation', () => { const r = repo(); return { r, create: () => new DesignationService(r, ds(0)).create({ code: 'A', name: 'X' } as any) }; }],
      ['cast', () => { const r = repo(); return { r, create: () => new CastCategoryService(r).create({ id: 1, name: 'X' } as any) }; }],
    ];
    for (const [, build] of cases) {
      const ok = build();
      await expect(ok.create()).resolves.toBeDefined();
      expect(ok.r.save).toHaveBeenCalledTimes(1);
      const dup = build(); dup.r.findOne.mockResolvedValue({ existing: true });
      await expect(dup.create()).rejects.toThrow(ConflictException);
      expect(dup.r.save).not.toHaveBeenCalled();
    }
  });
  it('the existence check looks for the key that was sent', async () => {
    const r = repo(); await new OfficeService(r, ds(0)).create({ officeId: 42, name: 'X' } as any);
    expect(r.findOne).toHaveBeenCalledWith({ where: { officeId: 42 } });
    const w = repo(); await new WingService(w, ds(0)).create({ wingId: 'W9', name: 'X' } as any);
    expect(w.findOne).toHaveBeenCalledWith({ where: { wingId: 'W9' } });
  });
  it('a designation that no member holds can be deleted, one that is held is refused with the count, nothing is deleted', async () => {
    const free = repo(); await expect(new DesignationService(free, ds(0)).remove('A')).resolves.toBeUndefined();
    expect(free.delete).toHaveBeenCalledWith('A');
    const held = repo(); const d = ds(4);
    await expect(new DesignationService(held, d).remove('A')).rejects.toThrow(/4 member/);
    expect(held.delete).not.toHaveBeenCalled();
    expect(d.query.mock.calls[0][1]).toEqual(['A']);
  });
});

describe('admin member funds / balances: no rows for members that do not exist (ES-300)', () => {
  const funds = (member: boolean, existing?: any) => {
    const r = repo({ findOne: jest.fn().mockResolvedValue(existing ?? null), manager: { query: jest.fn().mockResolvedValue(member ? [{ 1: 1 }] : []) } });
    return { svc: new MemberFundsService(r), r };
  };
  it('funds: unknown member -> 404 and nothing saved; real member -> row created', async () => {
    const bad = funds(false);
    await expect(bad.svc.updateBalances(987654321, { sharesInstallment: 5 } as any)).rejects.toThrow(NotFoundException);
    expect(bad.r.save).not.toHaveBeenCalled();
    const good = funds(true);
    await expect(good.svc.updateBalances(5, { sharesInstallment: 5 } as any)).resolves.toBeDefined();
    expect(good.r.save).toHaveBeenCalled();
  });
  it('funds: an existing row is updated without any member lookup', async () => {
    const { svc, r } = funds(false, { memberNo: 5, sharesInstallment: 1 });
    await expect(svc.updateBalances(5, { sharesInstallment: 9 } as any)).resolves.toMatchObject({ sharesInstallment: 9 });
    expect(r.manager.query).not.toHaveBeenCalled();
  });
  it('funds: the member number is a bound parameter', async () => {
    const { svc, r } = funds(true);
    await svc.updateBalances(5, { sharesInstallment: 5 } as any);
    expect(r.manager.query.mock.calls[0][1]).toEqual([5]);
  });
  const balances = (member: boolean, existing?: any) => {
    const r = repo({ findOne: jest.fn().mockResolvedValue(existing ?? null), manager: { query: jest.fn().mockResolvedValue(member ? [{ 1: 1 }] : []) } });
    return { svc: new MemberBalanceService(r), r };
  };
  it('balances: unknown member -> 404 and nothing saved; real member -> row created; existing row -> merged without a lookup', async () => {
    const bad = balances(false);
    await expect(bad.svc.update(987654321, { shareBalance: 5 } as any)).rejects.toThrow(NotFoundException);
    expect(bad.r.save).not.toHaveBeenCalled();
    const good = balances(true);
    await expect(good.svc.update(5, { shareBalance: 5 } as any)).resolves.toBeDefined();
    expect(good.r.save).toHaveBeenCalled();
    const have = balances(false, { memberNo: 5, shareBalance: 1 });
    await expect(have.svc.update(5, { shareBalance: 9 } as any)).resolves.toMatchObject({ shareBalance: 9 });
    expect(have.r.manager.query).not.toHaveBeenCalled();
  });
});
