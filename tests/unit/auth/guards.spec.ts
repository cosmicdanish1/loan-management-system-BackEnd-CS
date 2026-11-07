import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleGuard } from '../../../src/modules/auth/guards/role.guard';
import { PermissionsGuard } from '../../../src/modules/auth/guards/permissions.guard';
import { MenuRightGuard } from '../../../src/modules/auth/guards/menu-right.guard';
import { PassAuthorityGuard } from '../../../src/modules/auth/guards/pass-authority.guard';
import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { TwoFaManageGuard, canManageTwoFactor, isAdminUser } from '../../../src/modules/auth/twofa/manage.guard';
import { AuthCodeGuard } from '../../../src/modules/auth/twofa/require-auth-code';
import { UserPermission } from '../../../src/modules/auth/entities/user.entity';

const ctx = (user?: any, extra: any = {}) => ({
  getHandler: () => 'h', getClass: () => 'c',
  switchToHttp: () => ({ getRequest: () => ({ user, params: {}, headers: {}, ...extra }) }),
}) as any;
const reflectorWith = (map: Record<string, any>) => ({
  getAllAndOverride: (k: string) => map[k], get: (k: string) => map[k],
}) as unknown as Reflector;
const userWith = (role: string, perms: string[] = [], canPass = false) => ({
  role, canPassTransactions: canPass, hasPermission: (p: string) => perms.includes(p),
});

describe('auth/RoleGuard', () => {
  it('allows when no role or permission is required', () => {
    expect(new RoleGuard(reflectorWith({})).canActivate(ctx())).toBe(true);
  });
  it('403 when a role is required and nobody is signed in', () => {
    expect(() => new RoleGuard(reflectorWith({ roles: ['clerk'] })).canActivate(ctx())).toThrow(ForbiddenException);
  });
  it('lets administrator / admin / sample_1 pass every role check', () => {
    for (const r of ['administrator', 'ADMIN', 'sample_1']) {
      expect(new RoleGuard(reflectorWith({ roles: ['clerk'] })).canActivate(ctx(userWith(r)))).toBe(true);
    }
  });
  it('allows a matching role', () => {
    expect(new RoleGuard(reflectorWith({ roles: ['clerk'] })).canActivate(ctx(userWith('Clerk')))).toBe(true);
  });
  it('403 for a non matching role', () => {
    expect(() => new RoleGuard(reflectorWith({ roles: ['administrator'] })).canActivate(ctx(userWith('clerk')))).toThrow(ForbiddenException);
  });
  it('403 when the user has none of the required permissions', () => {
    const g = new RoleGuard(reflectorWith({ permissions: [UserPermission.APPROVE_LOAN] }));
    expect(() => g.canActivate(ctx(userWith('clerk', [])))).toThrow(ForbiddenException);
  });
  it('allows when the user has one of the required permissions', () => {
    const g = new RoleGuard(reflectorWith({ permissions: [UserPermission.APPROVE_LOAN] }));
    expect(g.canActivate(ctx(userWith('clerk', [UserPermission.APPROVE_LOAN])))).toBe(true);
  });
  it('403 for a user with no role at all when a role is required', () => {
    expect(() => new RoleGuard(reflectorWith({ roles: ['clerk'] })).canActivate(ctx({ hasPermission: () => false }))).toThrow(ForbiddenException);
  });
});

describe('auth/PermissionsGuard', () => {
  it('allows when nothing is required', () => {
    expect(new PermissionsGuard(reflectorWith({})).canActivate(ctx())).toBe(true);
  });
  it('403 when not signed in', () => {
    expect(() => new PermissionsGuard(reflectorWith({ permissions: [UserPermission.READ_LOAN] })).canActivate(ctx())).toThrow(ForbiddenException);
  });
  it('administrator bypasses', () => {
    expect(new PermissionsGuard(reflectorWith({ permissions: [UserPermission.PERFORM_BACKUP] })).canActivate(ctx(userWith('administrator')))).toBe(true);
  });
  it('Transaction Auth user passes loan-only permissions', () => {
    const g = new PermissionsGuard(reflectorWith({ permissions: [UserPermission.APPROVE_LOAN] }));
    expect(g.canActivate(ctx(userWith('clerk', [], true)))).toBe(true);
  });
  it('Transaction Auth does NOT unlock non-loan permissions', () => {
    const g = new PermissionsGuard(reflectorWith({ permissions: [UserPermission.PERFORM_BACKUP] }));
    expect(() => g.canActivate(ctx(userWith('clerk', [], true)))).toThrow(ForbiddenException);
  });
  it('Transaction Auth does NOT unlock a mix of loan and non-loan permissions', () => {
    const g = new PermissionsGuard(reflectorWith({ permissions: [UserPermission.APPROVE_LOAN, UserPermission.MANAGE_USERS] }));
    expect(() => g.canActivate(ctx(userWith('clerk', [], true)))).toThrow(ForbiddenException);
  });
  it('allows an explicit permission', () => {
    const g = new PermissionsGuard(reflectorWith({ permissions: [UserPermission.READ_MEMBER] }));
    expect(g.canActivate(ctx(userWith('clerk', [UserPermission.READ_MEMBER])))).toBe(true);
  });
});

describe('auth/MenuRightGuard', () => {
  const mk = (rows: any[], allowed: string[] | null, actions: string[] | undefined | 'default' = 'default') => {
    const acts = actions === 'default' ? ['LOAN_EARLY_CLOSURE'] : actions;
    const ds: any = { query: jest.fn().mockResolvedValue(rows) };
    const auth: any = { getAllowedActions: jest.fn().mockResolvedValue(allowed) };
    return { g: new MenuRightGuard(reflectorWith({ requireMenuAction: acts }), ds, auth), ds, auth };
  };
  it('allows an unmarked endpoint without a DB call', async () => {
    const { g, ds } = mk([], null, null as any);
    expect(await g.canActivate(ctx({ id: 1 }))).toBe(true);
    expect(ds.query).not.toHaveBeenCalled();
  });
  it('defers to the JWT guard when nobody is signed in', async () => {
    expect(await mk([], null).g.canActivate(ctx())).toBe(true);
  });
  it('403 when the user row is missing', async () => {
    await expect(mk([], null).g.canActivate(ctx({ id: 1 }))).rejects.toThrow(ForbiddenException);
  });
  it('allows an unrestricted level (allowed === null)', async () => {
    expect(await mk([{ userlevelid: '1' }], null).g.canActivate(ctx({ id: 1 }))).toBe(true);
  });
  it('allows when the right is granted', async () => {
    expect(await mk([{ userlevelid: '3' }], ['LOAN_EARLY_CLOSURE']).g.canActivate(ctx({ id: 1 }))).toBe(true);
  });
  it('403 MENU_RIGHT_REQUIRED when the right is missing', async () => {
    await expect(mk([{ userlevelid: '3' }], ['OTHER']).g.canActivate(ctx({ id: 1 }))).rejects.toMatchObject({ response: { code: 'MENU_RIGHT_REQUIRED' } });
  });
  it('403 when the allowed list is empty', async () => {
    await expect(mk([{ userlevelid: '3' }], []).g.canActivate(ctx({ id: 1 }))).rejects.toThrow(ForbiddenException);
  });
  it('allows when ANY of several actions is granted', async () => {
    expect(await mk([{ userlevelid: '3' }], ['B'], ['A', 'B']).g.canActivate(ctx({ id: 1 }))).toBe(true);
  });
});

describe('auth/PassAuthorityGuard', () => {
  const mk = (rows: any[], allowed: string[] | null, marked = true) => {
    const ds: any = { query: jest.fn().mockResolvedValue(rows) };
    const auth: any = { getAllowedActions: jest.fn().mockResolvedValue(allowed) };
    return new PassAuthorityGuard(reflectorWith({ requirePassAuthority: marked }), ds, auth);
  };
  it('allows an unmarked endpoint', async () => {
    expect(await mk([], null, false).canActivate(ctx({ id: 1 }))).toBe(true);
  });
  it('403 when the user row is missing', async () => {
    await expect(mk([], null).canActivate(ctx({ id: 1 }))).rejects.toThrow(ForbiddenException);
  });
  it('403 PASS_AUTHORITY_REQUIRED when the Transaction Auth flag is N', async () => {
    await expect(mk([{ userlevelid: 1, pass_transaction_flag: 'N' }], null).canActivate(ctx({ id: 1 }))).rejects.toMatchObject({ response: { code: 'PASS_AUTHORITY_REQUIRED' } });
  });
  it('403 when the flag is NULL', async () => {
    await expect(mk([{ userlevelid: 1, pass_transaction_flag: null }], null).canActivate(ctx({ id: 1 }))).rejects.toThrow(ForbiddenException);
  });
  it('flag y (lower case) counts as Y', async () => {
    expect(await mk([{ userlevelid: 1, pass_transaction_flag: 'y' }], null).canActivate(ctx({ id: 1 }))).toBe(true);
  });
  it('403 when the level lacks PASS_TRANSACTIONS', async () => {
    await expect(mk([{ userlevelid: 1, pass_transaction_flag: 'Y' }], ['X']).canActivate(ctx({ id: 1 }))).rejects.toMatchObject({ response: { code: 'MENU_RIGHT_REQUIRED' } });
  });
  it('allows with flag Y and the right', async () => {
    expect(await mk([{ userlevelid: 1, pass_transaction_flag: 'Y' }], ['PASS_TRANSACTIONS']).canActivate(ctx({ id: 1 }))).toBe(true);
  });
});

describe('auth/JwtAuthGuard', () => {
  it('lets a @Public route through without a token', () => {
    const g = new JwtAuthGuard(reflectorWith({ isPublic: true }));
    expect(g.canActivate(ctx())).toBe(true);
  });
});

describe('auth/TwoFaManageGuard', () => {
  it('isAdminUser recognises administrator, admin, sample_1, system (any case)', () => {
    for (const r of ['Administrator', 'ADMIN', 'sample_1', 'SYSTEM']) expect(isAdminUser({ role: r })).toBe(true);
    expect(isAdminUser({ role: 'clerk' })).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });
  it('a clerk with manage_two_factor permission may manage', () => {
    expect(canManageTwoFactor({ role: 'clerk', permissions: ['manage_two_factor'] })).toBe(true);
  });
  it('a clerk without the right may not', () => {
    expect(canManageTwoFactor({ role: 'clerk', permissions: [] })).toBe(false);
    expect(canManageTwoFactor({ role: 'clerk' })).toBe(false);
  });
  it('guard throws 403 for a non-manager and allows an admin', () => {
    const g = new TwoFaManageGuard();
    expect(() => g.canActivate(ctx({ role: 'clerk', permissions: [] }))).toThrow(ForbiddenException);
    expect(g.canActivate(ctx({ role: 'administrator' }))).toBe(true);
  });
});

describe('auth/AuthCodeGuard', () => {
  it('allows an unmarked endpoint', async () => {
    const twofa: any = { enforceActions: jest.fn() };
    expect(await new AuthCodeGuard(reflectorWith({}), twofa).canActivate(ctx({ id: 1 }))).toBe(true);
    expect(twofa.enforceActions).not.toHaveBeenCalled();
  });
  it('passes the fixed actions, user and X-Auth-Code header to enforceActions', async () => {
    const twofa: any = { enforceActions: jest.fn().mockResolvedValue(undefined) };
    const g = new AuthCodeGuard(reflectorWith({ requireAuthCode: ['LOAN_PASS'] }), twofa);
    await g.canActivate(ctx({ id: 7, username: 'bob' }, { headers: { 'x-auth-code': '123456' }, params: { id: '9' } }));
    expect(twofa.enforceActions).toHaveBeenCalledWith(['LOAN_PASS'], { id: 7, username: 'bob' }, '123456', '9');
  });
  it('resolves function actions and drops null results', async () => {
    const twofa: any = { enforceActions: jest.fn().mockResolvedValue(undefined) };
    const g = new AuthCodeGuard(reflectorWith({ requireAuthCode: [() => null, async () => 'B'] }), twofa);
    await g.canActivate(ctx({ id: 1, username: 'u' }));
    expect(twofa.enforceActions.mock.calls[0][0]).toEqual(['B']);
  });
  it('propagates the refusal of enforceActions', async () => {
    const twofa: any = { enforceActions: jest.fn().mockRejectedValue(new UnauthorizedException('code')) };
    await expect(new AuthCodeGuard(reflectorWith({ requireAuthCode: ['A'] }), twofa).canActivate(ctx({ id: 1, username: 'u' }))).rejects.toThrow(UnauthorizedException);
  });
  it('defers to the JWT guard when nobody is signed in', async () => {
    const twofa: any = { enforceActions: jest.fn() };
    expect(await new AuthCodeGuard(reflectorWith({ requireAuthCode: ['A'] }), twofa).canActivate(ctx())).toBe(true);
  });
});
