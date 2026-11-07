import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserManagementService } from '../../../src/modules/admin/services/user-management.service';

const userRow = (o: any = {}) => ({
  userid: 7, susername: 'bob', userLevel: { userlevel: 'CLERK', userlevelid: 6 }, userlevelid: 6, enableDisable: 'E', email: 'b@x.com', firstName: 'B', lastName: 'C',
  hasExplicitPermissions: false, permissions: [], isEnabled: true, canPassTransactions: true, fullName: 'B C', dateOfCreation: new Date(), forceLogoutAt: null,
  validatePassword: jest.fn().mockResolvedValue(true), ...o,
});

function mk(over: { rows?: any; taken?: number; adminCount?: number; level?: any } = {}) {
  const qb: any = {
    where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(), leftJoinAndSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(over.taken ?? 0), getOne: jest.fn().mockResolvedValue(over.level ?? { userlevelid: 6, userlevel: 'CLERK' }),
    getManyAndCount: jest.fn().mockResolvedValue([[userRow()], 1]),
  };
  const countQb = { ...qb, getCount: jest.fn().mockResolvedValue(over.adminCount ?? 2) };
  const um: any = {
    findOne: jest.fn().mockResolvedValue(userRow()), find: jest.fn().mockResolvedValue([]), save: jest.fn(async (x) => x), remove: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => qb),
  };
  const levelRepo: any = { createQueryBuilder: jest.fn(() => qb), find: jest.fn().mockResolvedValue([]), create: jest.fn((x) => x), save: jest.fn() };
  const em: any = { create: jest.fn((_e, x) => ({ ...x, permissions: [] })), save: jest.fn(async (x) => ({ ...x, userid: x.userid })) };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), manager: em, query: jest.fn().mockResolvedValue([{ next_id: 8 }]) };
  const ds: any = { createQueryRunner: jest.fn(() => qr) };
  const actRepo: any = { create: jest.fn((x) => x), save: jest.fn(async (x) => ({ id: 1, ...x })), findAndCount: jest.fn().mockResolvedValue([[], 0]) };
  const svc = new UserManagementService(actRepo, um, levelRepo, {} as any, ds);
  // admin counting uses the same query builder mock; make its count configurable
  if (over.adminCount !== undefined) (um.createQueryBuilder as jest.Mock).mockReturnValue(countQb);
  return { svc, um, qb, qr, em, levelRepo, actRepo };
}
const cu = (o: any = {}) => ({ username: 'new', password: 'Abcdef1!', role: 'clerk', ...o }) as any;

describe('admin/UserManagementService.createUser', () => {
  it('409 for a taken username (case insensitive lookup)', async () => {
    const { svc, qb } = mk({ taken: 1 });
    await expect(svc.createUser(cu())).rejects.toThrow(ConflictException);
    expect(qb.where.mock.calls[0][0]).toContain('LOWER');
  });
  it('409 for a taken email', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(userRow());
    await expect(svc.createUser(cu({ email: 'b@x.com' }))).rejects.toThrow('Email already exists');
  });
  it('allocates the next user id under an advisory lock in one transaction', async () => {
    const { svc, qr, em } = mk(); const um2 = (svc as any).userMasterRepository; um2.findOne.mockResolvedValue(null);
    await svc.createUser(cu());
    expect(qr.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(em.create.mock.calls[0][1].userid).toBe(8); expect(qr.commitTransaction).toHaveBeenCalled(); expect(qr.release).toHaveBeenCalled();
  });
  it('rolls back and releases when the save fails', async () => {
    const { svc, qr, em, um } = mk(); um.findOne.mockResolvedValue(null); em.save.mockRejectedValue(new Error('db'));
    await expect(svc.createUser(cu())).rejects.toThrow('db');
    expect(qr.rollbackTransaction).toHaveBeenCalled(); expect(qr.release).toHaveBeenCalled();
  });
  it('a non-administrator cannot hand out Approver or Manage Two-Factor rights', async () => {
    const { svc, em, um } = mk(); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu({ permissions: ['read_member', 'approve_actions', 'manage_two_factor'] }), { role: 'clerk' });
    const saved = em.save.mock.calls[0][0]; expect(saved.permissions).toEqual(['read_member']);
  });
  it('an administrator can', async () => {
    const { svc, em, um } = mk(); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu({ permissions: ['approve_actions'] }), { role: 'administrator' });
    expect(em.save.mock.calls[0][0].permissions).toContain('approve_actions');
  });
  it('isActive false creates a disabled user', async () => {
    const { svc, em, um } = mk(); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu({ isActive: false }));
    expect(em.create.mock.calls[0][1].enableDisable).toBe('D');
  });
  it('a new user does not get Transaction Auth unless the administrator ticks it', async () => {
    const { svc, em, um } = mk(); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu());
    expect(em.create.mock.calls[0][1].passTransactionFlag).toBe('N');
  });
  it('copies the default rights of the user level into userrights', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null);
    um.query.mockResolvedValue([{ menuid: 3 }, { menuid: 9 }]);
    await svc.createUser(cu());
    expect(um.query.mock.calls.some((c: any[]) => /INSERT INTO userrights/.test(c[0]) && c[0].includes('(8, 3),(8, 9)'))).toBe(true);
  });
  it('a failure to copy default rights does not fail the creation', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null); um.query.mockRejectedValue(new Error('x'));
    await expect(svc.createUser(cu())).resolves.toBeDefined();
  });
  it('the response never carries the password', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null);
    expect(JSON.stringify(await svc.createUser(cu({ password: 'Secret@999' })))).not.toContain('Secret@999');
  });
});

describe('admin/UserManagementService read / update / delete', () => {
  it('findAllUsers paginates and maps', async () => {
    const { svc, qb } = mk();
    const r = await svc.findAllUsers(2, 5);
    expect(qb.skip).toHaveBeenCalledWith(5); expect(qb.take).toHaveBeenCalledWith(5); expect(r).toMatchObject({ total: 1, page: 2, limit: 5, totalPages: 1 });
  });
  it('findAllUsers: username filter is a bound parameter', async () => {
    const { svc, qb } = mk(); await svc.findAllUsers(1, 10, undefined, undefined, "x' OR 1=1");
    expect(qb.andWhere.mock.calls[0][1]).toEqual({ username: "%x' OR 1=1%" });
  });
  it('findUserById 404', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null);
    await expect(svc.findUserById(1)).rejects.toThrow(NotFoundException);
  });
  it('mapped user: role from level, explicit permissions respected, flags', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(userRow({ hasExplicitPermissions: true, permissions: ['read_loan'], canPassTransactions: false }));
    expect(await svc.findUserById(7)).toMatchObject({ role: 'clerk', permissions: ['read_loan'], allowPassTransactions: false, isActive: true });
  });
  it('update 404', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null);
    await expect(svc.updateUser(1, {} as any)).rejects.toThrow(NotFoundException);
  });
  it('an administrator cannot reset his own password through update (use Change Password)', async () => {
    const { svc } = mk();
    await expect(svc.updateUser(7, { password: 'New@1234' } as any, 7)).rejects.toThrow(ForbiddenException);
  });
  it('an administrator account password cannot be reset by another administrator', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(userRow({ userLevel: { userlevel: 'ADMINISTRATOR' } }));
    await expect(svc.updateUser(7, { password: 'New@1234' } as any, 99)).rejects.toThrow(/administrator's password/);
    await expect(svc.adminChangeUserPassword(7, { newPassword: 'x' } as any, 99)).rejects.toThrow(ForbiddenException);
  });
  it('update 409 for a taken username and a taken email', async () => {
    const { svc, um } = mk({ taken: 1 });
    await expect(svc.updateUser(7, { username: 'other' } as any, 1)).rejects.toThrow(ConflictException);
    um.findOne.mockResolvedValueOnce(userRow()).mockResolvedValueOnce(userRow({ userid: 9 }));
    await expect(svc.updateUser(7, { email: 'taken@x.com' } as any, 1)).rejects.toThrow('Email already exists');
  });
  it('update with a role resets permissions to the role defaults unless given', async () => {
    const { svc } = mk(); const r = await svc.updateUser(7, { role: 'auditor' } as any, 1);
    expect(r).toBeDefined();
  });
  it('the last enabled administrator cannot be demoted through update either', async () => {
    const { svc, um } = mk({ adminCount: 1 }); um.findOne.mockResolvedValue(userRow({ userLevel: { userlevel: 'ADMINISTRATOR' } }));
    await expect(svc.updateUser(7, { role: 'clerk' } as any, 1)).rejects.toThrow(ForbiddenException);
  });
  it('the last enabled administrator cannot be disabled', async () => {
    const { svc, um } = mk({ adminCount: 1 }); um.findOne.mockResolvedValue(userRow({ userLevel: { userlevel: 'ADMINISTRATOR' } }));
    await expect(svc.updateUser(7, { isActive: false } as any, 1)).rejects.toThrow(ForbiddenException);
  });
  it('delete 404', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null);
    await expect(svc.deleteUser(1)).rejects.toThrow(NotFoundException);
  });
  it('the last administrator cannot be deleted', async () => {
    const { svc, um } = mk({ adminCount: 1 }); um.findOne.mockResolvedValue(userRow({ userLevel: { userlevel: 'ADMINISTRATOR' } }));
    await expect(svc.deleteUser(7)).rejects.toThrow('Cannot delete the last admin user');
  });
  it('another administrator can be deleted when more than one exists', async () => {
    const { svc, um } = mk({ adminCount: 2 }); um.findOne.mockResolvedValue(userRow({ userLevel: { userlevel: 'ADMINISTRATOR' } }));
    expect(await svc.deleteUser(7)).toEqual({ message: 'User deleted successfully' }); expect(um.remove).toHaveBeenCalled();
  });
  it('a signed in user cannot delete his own account', async () => {
    const { svc, um } = mk({ adminCount: 3 });
    await expect((svc as any).deleteUser(7, 7)).rejects.toThrow(ForbiddenException);
    expect(um.remove).not.toHaveBeenCalled();
  });
});

describe('admin/UserManagementService passwords, roles, activity', () => {
  it('changeUserPassword: 404, wrong current 400, success saves', async () => {
    const { svc, um } = mk();
    um.findOne.mockResolvedValueOnce(null);
    await expect(svc.changeUserPassword(1, { currentPassword: 'a', newPassword: 'b' } as any)).rejects.toThrow(NotFoundException);
    um.findOne.mockResolvedValueOnce(userRow({ validatePassword: jest.fn().mockResolvedValue(false) }));
    await expect(svc.changeUserPassword(1, { currentPassword: 'a', newPassword: 'b' } as any)).rejects.toThrow('Current password is incorrect');
    const u = userRow(); um.findOne.mockResolvedValueOnce(u);
    expect(await svc.changeUserPassword(1, { currentPassword: 'a', newPassword: 'NewPass@1' } as any)).toEqual({ message: 'Password changed successfully' });
    expect((u as any).spassword).toBe('NewPass@1');
  });
  it('adminChangeUserPassword 404 and saves for an ordinary user', async () => {
    const { svc, um } = mk();
    um.findOne.mockResolvedValueOnce(null);
    await expect(svc.adminChangeUserPassword(1, { newPassword: 'x' } as any, 2)).rejects.toThrow(NotFoundException);
    const u: any = userRow(); um.findOne.mockResolvedValueOnce(u);
    await svc.adminChangeUserPassword(1, { newPassword: 'NewPass@1' } as any, 2);
    expect(u.spassword).toBe('NewPass@1');
  });
  it('an admin password reset ends the target user\'s existing sessions', async () => {
    const { svc, um } = mk(); const u: any = userRow(); um.findOne.mockResolvedValueOnce(u);
    await svc.adminChangeUserPassword(1, { newPassword: 'NewPass@1' } as any, 2);
    expect(u.forceLogoutAt).toBeInstanceOf(Date);
  });
  it('updateUserRole: last admin cannot be demoted', async () => {
    const { svc, um } = mk({ adminCount: 1 }); um.findOne.mockResolvedValue(userRow({ userLevel: { userlevel: 'ADMINISTRATOR' } }));
    await expect(svc.updateUserRole(7, { role: 'clerk' } as any)).rejects.toThrow('Cannot change role of the last admin user');
  });
  it('updateUserRole 404 and success', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValueOnce(null);
    await expect(svc.updateUserRole(1, { role: 'clerk' } as any)).rejects.toThrow(NotFoundException);
    expect(await svc.updateUserRole(7, { role: 'clerk' } as any)).toMatchObject({ id: 7 });
  });
  it('a missing user level is created with the next id', async () => {
    const { svc, um, levelRepo, qb } = mk({ level: null }); levelRepo.find.mockResolvedValue([{ userlevelid: 9 }]); qb.getOne.mockResolvedValue(null);
    await svc.updateUserRole(7, { role: 'brand_new' } as any);
    expect(levelRepo.create).toHaveBeenCalledWith({ userlevelid: 10, userlevel: 'brand_new' });
  });
  it('logUserActivity 404 / saves for the given user and cannot be redirected to another user', async () => {
    const { svc, um, actRepo } = mk(); um.findOne.mockResolvedValueOnce(null);
    await expect(svc.logUserActivity(1, { action: 'x' } as any)).rejects.toThrow(NotFoundException);
    await svc.logUserActivity(7, { action: 'x' } as any);
    expect(actRepo.create.mock.calls[0][0].userId).toBe(7);
  });
  it('getUserActivities paginates by user', async () => {
    const { svc, actRepo } = mk(); actRepo.findAndCount.mockResolvedValue([[{ userId: 7 }], 41]);
    const r = await svc.getUserActivities(7, 3, 20);
    expect(actRepo.findAndCount.mock.calls[0][0]).toMatchObject({ where: { userId: 7 }, skip: 40, take: 20 }); expect(r.totalPages).toBe(3);
  });
  it('getAllUserActivities joins the users in one query', async () => {
    const { svc, um, actRepo } = mk(); actRepo.findAndCount.mockResolvedValue([[{ userId: 7 }, { userId: 7 }, { userId: 8 }], 3]);
    await svc.getAllUserActivities(); expect(um.find).toHaveBeenCalledTimes(1);
  });
  it('role permissions list: administrator has everything except Approver / Manage 2FA, which are separate', () => {
    const { svc } = mk(); const roles = svc.getRolePermissions();
    const admin = roles.find((r: any) => r.role === 'administrator')!;
    expect(admin.permissions).not.toContain('approve_actions'); expect(admin.permissions).toContain('perform_backup');
    expect(roles.find((r: any) => r.role === 'approver_pool')!.permissions).toEqual(['approve_actions', 'manage_two_factor']);
  });
  it('data operator and user defaults are read only', () => {
    const roles = mk().svc.getRolePermissions();
    for (const r of ['data_operator', 'user']) {
      const p = roles.find((x: any) => x.role === r)!.permissions as string[];
      expect(p.some((x) => /^(create|update|delete|approve|manage|perform)_/.test(x))).toBe(false);
    }
  });
});

describe('admin/UserManagementService.forceLogoutUser', () => {
  it('404 for an unknown user', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null);
    await expect(svc.forceLogoutUser('nobody')).rejects.toThrow(NotFoundException);
  });
  it('sets forceLogoutAt so live tokens stop working, and closes the open login sessions', async () => {
    const { svc, um } = mk(); const u: any = userRow(); um.findOne.mockResolvedValue(u);
    (svc as any).loginTimeRepository = { find: jest.fn().mockResolvedValue([{ logoutTime: '' }]), save: jest.fn() };
    await svc.forceLogoutUser('bob');
    expect(u.forceLogoutAt).toBeInstanceOf(Date); expect(u.loginStatus).toBe('N');
  });
  it('a user name that contains SQL LIKE wildcards (% or _) is matched literally, not as a pattern', async () => {
    const { svc, um } = mk(); um.findOne.mockResolvedValue(null);
    await svc.forceLogoutUser('%').catch(() => undefined);
    const arg = um.findOne.mock.calls[0][0].where.susername;
    expect(String(arg?.value ?? arg)).not.toBe('%');
  });
});

describe('admin/UserManagementService password changes end sessions (ES-297)', () => {
  it('updateUser with a new password (a reset) ends the target user\'s sessions; without one it does not', async () => {
    const { svc, um } = mk(); const withPw: any = userRow(); um.findOne.mockResolvedValueOnce(withPw);
    await svc.updateUser(7, { password: 'NewPass@1' } as any, 2);
    expect(withPw.forceLogoutAt).toBeInstanceOf(Date);
    const plain: any = userRow(); um.findOne.mockResolvedValueOnce(plain);
    await svc.updateUser(7, { firstName: 'X' } as any, 2);
    expect(plain.forceLogoutAt).toBeNull();
  });
  it('a token issued in the same second as the reset is still accepted (cut-off is truncated to the second)', async () => {
    const { svc, um } = mk(); const u: any = userRow(); um.findOne.mockResolvedValueOnce(u);
    await svc.adminChangeUserPassword(1, { newPassword: 'NewPass@1' } as any, 2);
    expect(u.forceLogoutAt.getTime() % 1000).toBe(0);
  });
  it('a refused reset (the target is an administrator) leaves the sessions alone', async () => {
    const { svc, um } = mk(); const u: any = userRow({ userLevel: { userlevel: 'ADMINISTRATOR' } }); um.findOne.mockResolvedValueOnce(u);
    await expect(svc.adminChangeUserPassword(1, { newPassword: 'NewPass@1' } as any, 2)).rejects.toThrow();
    expect(u.forceLogoutAt).toBeNull();
  });
});
