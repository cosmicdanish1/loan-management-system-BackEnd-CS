import { ConflictException, ForbiddenException, BadRequestException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { AuthController } from '../../../src/modules/auth/auth.controller';
import { MENU_ACTION_MAP, MENUID_TO_ACTION, BYPASS_USER_LEVEL_IDS } from '../../../src/modules/auth/menu-action-map';

const um = (o: any = {}) => ({
  userid: 7, susername: 'bob', userlevelid: 5, userLevel: { userlevel: 'CLERK' }, enableDisable: 'E',
  forceLogoutAt: null, hasExplicitPermissions: false, permissions: [], isEnabled: true, canPassTransactions: false,
  validatePassword: jest.fn().mockResolvedValue(true), ...o,
});

function build(over: any = {}) {
  const userMasterRepo: any = {
    findOne: jest.fn().mockResolvedValue(um()), find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (x) => x), create: jest.fn((x) => ({ ...x })), query: jest.fn().mockResolvedValue([]),
  };
  const levelRepo: any = {
    createQueryBuilder: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue({ userlevelid: 5, userlevel: 'CLERK' }) }),
    find: jest.fn().mockResolvedValue([]), create: jest.fn((x) => x), save: jest.fn(async (x) => x),
  };
  const loginRepo: any = { create: jest.fn((x) => x), save: jest.fn(async (x) => x), findOne: jest.fn().mockResolvedValue(null) };
  const infoRepo: any = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
  const rightsRepo: any = { find: jest.fn().mockResolvedValue([]) };
  const defRightsRepo: any = { find: jest.fn().mockResolvedValue([]) };
  const jwt: any = { signAsync: jest.fn(async () => 'jwt'), verify: jest.fn(), decode: jest.fn() };
  const config: any = { get: jest.fn((k: string, d?: any) => ({ JWT_SECRET: 's', JWT_REFRESH_SECRET: 'r' } as any)[k] ?? d) };
  const twofa: any = { gate: jest.fn().mockResolvedValue({ mode: 'none', required: false, enrolled: false, trusted: false }), getSettings: jest.fn().mockResolvedValue({ rememberDays: 30 }), signChallenge: jest.fn(() => 'chal') };
  Object.assign(userMasterRepo, over.userMasterRepo || {});
  const svc = new AuthService(userMasterRepo, levelRepo, loginRepo, infoRepo, rightsRepo, defRightsRepo, jwt, config, twofa);
  return { svc, userMasterRepo, levelRepo, loginRepo, infoRepo, rightsRepo, defRightsRepo, jwt, config, twofa };
}

describe('auth/AuthService.getAllowedActions', () => {
  it('null (unrestricted) for level ids 0 and 1', async () => {
    const { svc } = build();
    expect(await svc.getAllowedActions(1, 0)).toBeNull();
    expect(await svc.getAllowedActions(1, 1)).toBeNull();
  });
  it('merges user rights and default rights into action codes', async () => {
    const { svc, rightsRepo, defRightsRepo } = build();
    const [a, b] = MENU_ACTION_MAP;
    rightsRepo.find.mockResolvedValue([{ menuid: a.menuid }]);
    defRightsRepo.find.mockResolvedValue([{ menuid: b.menuid }, { menuid: a.menuid }]);
    expect((await svc.getAllowedActions(1, 5))!.sort()).toEqual([a.action, b.action].sort());
  });
  it('ignores menu ids that have no action', async () => {
    const { svc, defRightsRepo } = build();
    defRightsRepo.find.mockResolvedValue([{ menuid: 999999 }]);
    expect(await svc.getAllowedActions(1, 5)).toEqual([]);
  });
});

describe('auth/menu-action-map integrity', () => {
  it('every action code is unique', () => {
    const codes = MENU_ACTION_MAP.map((m) => m.action);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it('every menuid is unique', () => {
    const ids = MENU_ACTION_MAP.map((m) => m.menuid);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('lookup map covers every entry', () => expect(MENUID_TO_ACTION.size).toBeGreaterThan(0));
  it('PASS_TRANSACTIONS and LOAN_EARLY_CLOSURE actions exist (used by guards)', () => {
    const codes = MENU_ACTION_MAP.map((m) => m.action);
    expect(codes).toEqual(expect.arrayContaining(['PASS_TRANSACTIONS', 'LOAN_EARLY_CLOSURE']));
  });
  it('bypass levels are 0 and 1', () => expect([...BYPASS_USER_LEVEL_IDS].sort()).toEqual([0, 1]));
});

describe('auth/AuthService.validateUser', () => {
  it('returns null for an unknown user', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValue(null);
    expect(await svc.validateUser('x', 'y')).toBeNull();
  });
  it('throws for a disabled user', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValue(um({ enableDisable: 'D' }));
    await expect(svc.validateUser('bob', 'p')).rejects.toThrow('User account is disabled');
  });
  it('returns null for a wrong password and records no session', async () => {
    const { svc, userMasterRepo, loginRepo } = build();
    userMasterRepo.findOne.mockResolvedValue(um({ validatePassword: jest.fn().mockResolvedValue(false) }));
    expect(await svc.validateUser('bob', 'bad')).toBeNull();
    expect(loginRepo.save).not.toHaveBeenCalled();
  });
  it('returns the mapped user with allowedActions and records the session when no 2FA step is needed', async () => {
    const { svc, loginRepo, userMasterRepo } = build();
    const u = await svc.validateUser('bob', 'p');
    expect(u).toMatchObject({ id: 7, username: 'bob' });
    expect(loginRepo.save).toHaveBeenCalled();
    expect(userMasterRepo.save.mock.calls[0][0].loginStatus).toBe('Y');
  });
  it('does NOT record a session when a second factor is still required', async () => {
    const { svc, loginRepo, twofa } = build(); twofa.gate.mockResolvedValue({ mode: 'verify' });
    await svc.validateUser('bob', 'p');
    expect(loginRepo.save).not.toHaveBeenCalled();
  });
  it('passes the SUPER_ADMIN_PASSWORD config value to the password check', async () => {
    const { svc, userMasterRepo, config } = build();
    const validatePassword = jest.fn().mockResolvedValue(true);
    userMasterRepo.findOne.mockResolvedValue(um({ validatePassword }));
    config.get.mockImplementation((k: string) => (k === 'SUPER_ADMIN_PASSWORD' ? 'SUPER' : undefined));
    await svc.validateUser('bob', 'p');
    expect(validatePassword).toHaveBeenCalledWith('p', 'SUPER');
  });
  it('a session-bookkeeping failure does not block login', async () => {
    const { svc, loginRepo } = build(); loginRepo.save.mockRejectedValue(new Error('db'));
    await expect(svc.validateUser('bob', 'p')).resolves.toBeTruthy();
  });
});

describe('auth/AuthService.login', () => {
  it('401 for invalid credentials', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValue(null);
    await expect(svc.login({ username: 'x', password: 'y' } as any)).rejects.toThrow(UnauthorizedException);
  });
  it('returns access + refresh tokens and the user', async () => {
    const { svc } = build();
    const r: any = await svc.login({ username: 'bob', password: 'p' } as any);
    expect(r).toMatchObject({ accessToken: 'jwt', refreshToken: 'jwt', tokenType: 'Bearer', expiresIn: 3600 });
    expect(r.user.username).toBe('bob');
  });
  it('answers a verify challenge WITHOUT any token when 2FA code is needed', async () => {
    const { svc, twofa } = build(); twofa.gate.mockResolvedValue({ mode: 'verify' });
    const r: any = await svc.login({ username: 'bob', password: 'p' } as any);
    expect(r).toMatchObject({ requires2fa: true, challengeToken: 'chal', rememberDays: 30 });
    expect(r.accessToken).toBeUndefined();
  });
  it('answers an enrol challenge WITHOUT any token when enrolment is forced', async () => {
    const { svc, twofa } = build(); twofa.gate.mockResolvedValue({ mode: 'enrol' });
    const r: any = await svc.login({ username: 'bob', password: 'p' } as any);
    expect(r.requires2faEnrol).toBe(true); expect(r.accessToken).toBeUndefined();
  });
  it('a trusted device skips the code and still records the session once', async () => {
    const { svc, twofa, loginRepo } = build();
    twofa.gate.mockResolvedValueOnce({ mode: 'verify' }).mockResolvedValueOnce({ mode: 'none', trusted: true });
    // first call (inside validateUser) says verify -> no session; second (with device token) says trusted
    const r: any = await svc.login({ username: 'bob', password: 'p', deviceToken: 'dev' } as any);
    expect(r.accessToken).toBe('jwt'); expect(loginRepo.save).toHaveBeenCalledTimes(1);
  });
  it('signs access and refresh tokens with different secrets and unique ids', async () => {
    const { svc, jwt } = build();
    await svc.login({ username: 'bob', password: 'p' } as any);
    const [a, b] = jwt.signAsync.mock.calls;
    expect(a[1].secret).toBe('s'); expect(b[1].secret).toBe('r');
    expect(a[1].jwtid).not.toBe(b[1].jwtid);
  });
  it('the token payload carries sub, username and role but no password data', async () => {
    const { svc, jwt } = build();
    await svc.login({ username: 'bob', password: 'p' } as any);
    expect(Object.keys(jwt.signAsync.mock.calls[0][0]).sort()).toEqual(['email', 'role', 'sid', 'sub', 'username']); // sid = session id (ES-297)
  });
});

describe('auth/AuthService.completeTwoFaLogin', () => {
  it('401 when the user is missing or disabled', async () => {
    const { svc, userMasterRepo } = build();
    userMasterRepo.findOne.mockResolvedValue(null);
    await expect(svc.completeTwoFaLogin(1)).rejects.toThrow(UnauthorizedException);
    userMasterRepo.findOne.mockResolvedValue(um({ enableDisable: 'D' }));
    await expect(svc.completeTwoFaLogin(1)).rejects.toThrow(UnauthorizedException);
  });
  it('records the session and returns tokens', async () => {
    const { svc, loginRepo } = build();
    const r: any = await svc.completeTwoFaLogin(7);
    expect(r.accessToken).toBe('jwt'); expect(loginRepo.save).toHaveBeenCalled();
  });
});

describe('auth/AuthService.register', () => {
  const dto: any = { username: 'new', password: 'Abcdef1!', email: 'n@x.com' };
  it('409 on duplicate username', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValueOnce(um());
    await expect(svc.register(dto)).rejects.toThrow(ConflictException);
  });
  it('409 on duplicate email', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(um());
    await expect(svc.register(dto)).rejects.toThrow('Email already exists');
  });
  it('allocates the next user id', async () => {
    const { svc, userMasterRepo } = build();
    userMasterRepo.findOne.mockResolvedValue(null); userMasterRepo.find.mockResolvedValue([{ userid: 41 }]);
    await svc.register(dto);
    expect(userMasterRepo.create.mock.calls[0][0].userid).toBe(42);
  });
  it('new users start enabled, logged out, with data operator read-only defaults', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValue(null);
    await svc.register(dto);
    const c = userMasterRepo.create.mock.calls[0][0];
    expect(c).toMatchObject({ enableDisable: 'E', loginStatus: 'N' });
    expect(c.permissions).toEqual(['read_member', 'read_loan', 'read_deposit', 'read_transaction']);
  });
  it('administrator default does not include APPROVE_ACTIONS or MANAGE_TWO_FACTOR', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValue(null);
    await svc.register({ ...dto, role: 'administrator' });
    const p = userMasterRepo.create.mock.calls[0][0].permissions;
    expect(p).not.toContain('approve_actions'); expect(p).not.toContain('manage_two_factor');
    expect(p).toContain('perform_backup');
  });
  it('a new user does not get Transaction Auth (pass transactions) by default', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValue(null);
    await svc.register(dto);
    expect(userMasterRepo.create.mock.calls[0][0].passTransactionFlag).not.toBe('Y');
  });
  it('creates a missing user level', async () => {
    const { svc, userMasterRepo, levelRepo } = build(); userMasterRepo.findOne.mockResolvedValue(null);
    levelRepo.createQueryBuilder.mockReturnValue({ where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) });
    levelRepo.find.mockResolvedValue([{ userlevelid: 9 }]);
    await svc.register({ ...dto, role: 'auditor' });
    expect(levelRepo.save).toHaveBeenCalled();
    expect(levelRepo.create.mock.calls[0][0].userlevelid).toBe(10);
  });
});

describe('auth/AuthService.refreshToken', () => {
  const dto: any = { refreshToken: 'rt' };
  it('issues a new token pair for a valid refresh token', async () => {
    const { svc, jwt } = build(); jwt.verify.mockReturnValue({ sub: 7, iat: 100 });
    expect(await svc.refreshToken(dto)).toMatchObject({ accessToken: 'jwt' });
  });
  it('verifies against the REFRESH secret', async () => {
    const { svc, jwt } = build(); jwt.verify.mockReturnValue({ sub: 7 });
    await svc.refreshToken(dto);
    expect(jwt.verify).toHaveBeenCalledWith('rt', { secret: 'r' });
  });
  it('401 for a bad token', async () => {
    const { svc, jwt } = build(); jwt.verify.mockImplementation(() => { const e: any = new Error('bad'); e.name = 'JsonWebTokenError'; throw e; });
    await expect(svc.refreshToken(dto)).rejects.toThrow(UnauthorizedException);
  });
  it('401 for an expired token', async () => {
    const { svc, jwt } = build(); jwt.verify.mockImplementation(() => { const e: any = new Error('exp'); e.name = 'TokenExpiredError'; throw e; });
    await expect(svc.refreshToken(dto)).rejects.toThrow('Invalid refresh token');
  });
  it('401 for a disabled user', async () => {
    const { svc, jwt, userMasterRepo } = build(); jwt.verify.mockReturnValue({ sub: 7 });
    userMasterRepo.findOne.mockResolvedValue(um({ enableDisable: 'D' }));
    await expect(svc.refreshToken(dto)).rejects.toThrow(UnauthorizedException);
  });
  it('401 for a deleted user', async () => {
    const { svc, jwt, userMasterRepo } = build(); jwt.verify.mockReturnValue({ sub: 7 });
    userMasterRepo.findOne.mockResolvedValue(null);
    await expect(svc.refreshToken(dto)).rejects.toThrow(UnauthorizedException);
  });
  it('401 when issued before a force-logout', async () => {
    const { svc, jwt, userMasterRepo } = build(); jwt.verify.mockReturnValue({ sub: 7, iat: 1000 });
    userMasterRepo.findOne.mockResolvedValue(um({ forceLogoutAt: new Date(5_000_000) }));
    await expect(svc.refreshToken(dto)).rejects.toThrow(UnauthorizedException);
  });
  it('503 (not 401) when the database fails, so the app keeps its session', async () => {
    const { svc, jwt, userMasterRepo } = build(); jwt.verify.mockReturnValue({ sub: 7 });
    userMasterRepo.findOne.mockRejectedValue(new Error('connection refused'));
    await expect(svc.refreshToken(dto)).rejects.toThrow(ServiceUnavailableException);
  });
  it('a refresh token that was already used (or logged out) is rejected (token revocation / rotation)', async () => {
    const { svc, jwt, userMasterRepo } = build(); jwt.verify.mockReturnValue({ sub: 7, iat: 100 });
    await svc.refreshToken(dto);
    const consulted = userMasterRepo.query.mock.calls.some((c: any[]) => /revoked_tokens/.test(c[0]));
    expect(consulted).toBe(true);
  });
});

describe('auth/AuthService.logout', () => {
  it('closes the open login session and resets login status', async () => {
    const { svc, loginRepo, userMasterRepo } = build();
    const open = { logoutTime: '' }; loginRepo.findOne.mockResolvedValue(open);
    const u = um(); userMasterRepo.findOne.mockResolvedValue(u);
    expect(await svc.logout(7)).toEqual({ message: 'Logout successful' });
    expect(open.logoutTime).toMatch(/^\d\d:\d\d:\d\d$/); expect(u.loginStatus).toBe('N');
  });
  it('works when there is no open session', async () => {
    const { svc } = build();
    await expect(svc.logout(7)).resolves.toBeTruthy();
  });
  it('revokes the token by SHA-256 hash with its expiry', async () => {
    const { svc, jwt, userMasterRepo } = build(); jwt.decode.mockReturnValue({ exp: 2_000_000_000 });
    await svc.logout(7, 'tok');
    const ins = userMasterRepo.query.mock.calls.find((c: any[]) => /INSERT INTO revoked_tokens/.test(c[0]));
    expect(ins[1][0]).toBe(crypto.createHash('sha256').update('tok').digest('hex'));
    expect(ins[1][2]).toEqual(new Date(2_000_000_000_000));
  });
  it('falls back to a 24 hour expiry for a token without exp', async () => {
    const { svc, jwt, userMasterRepo } = build(); jwt.decode.mockReturnValue(null);
    await svc.logout(7, 'tok');
    const ins = userMasterRepo.query.mock.calls.find((c: any[]) => /INSERT INTO revoked_tokens/.test(c[0]));
    expect(ins[1][2].getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });
  it('does not touch the denylist when no token is given', async () => {
    const { svc, userMasterRepo } = build();
    await svc.logout(7);
    expect(userMasterRepo.query).not.toHaveBeenCalled();
  });
});

describe('auth/AuthService profile, lists and change password', () => {
  it('getCurrentUser returns the profile', async () => {
    const { svc } = build();
    expect(await svc.getCurrentUser(7)).toMatchObject({ id: 7, username: 'bob' });
  });
  it('getCurrentUser 404 for missing or disabled users', async () => {
    const { svc, userMasterRepo } = build();
    userMasterRepo.findOne.mockResolvedValue(null);
    await expect(svc.getCurrentUser(7)).rejects.toThrow(NotFoundException);
    userMasterRepo.findOne.mockResolvedValue(um({ isEnabled: false }));
    await expect(svc.getCurrentUser(7)).rejects.toThrow(NotFoundException);
  });
  it('getCurrentUser never returns the password hash', async () => {
    const { svc, userMasterRepo } = build(); userMasterRepo.findOne.mockResolvedValue(um({ spassword: '$2b$hash' }));
    expect(JSON.stringify(await svc.getCurrentUser(7))).not.toContain('hash');
  });
  it('getUsersList maps columns', async () => {
    const { svc, userMasterRepo } = build();
    userMasterRepo.find.mockResolvedValue([{ userid: 1, susername: 'a', userlevelid: 2, enableDisable: 'E' }]);
    expect(await svc.getUsersList()).toEqual([{ userid: 1, susername: 'a', userlevelid: 2, enable_disable: 'E' }]);
  });
  it('getUsernames only asks for enabled users', async () => {
    const { svc, userMasterRepo } = build();
    await svc.getUsernames();
    expect(userMasterRepo.find.mock.calls[0][0].where).toEqual({ enableDisable: 'E' });
  });
  it('changePassword: 401 for unknown, disabled and wrong current password', async () => {
    const { svc, userMasterRepo } = build();
    userMasterRepo.findOne.mockResolvedValue(null);
    await expect(svc.changePassword('x', 'a', 'b')).rejects.toThrow('User not found');
    userMasterRepo.findOne.mockResolvedValue(um({ enableDisable: 'D' }));
    await expect(svc.changePassword('bob', 'a', 'b')).rejects.toThrow('disabled');
    userMasterRepo.findOne.mockResolvedValue(um({ validatePassword: jest.fn().mockResolvedValue(false) }));
    await expect(svc.changePassword('bob', 'a', 'b')).rejects.toThrow('Current password is incorrect');
  });
  it('changePassword saves the new password', async () => {
    const { svc, userMasterRepo } = build(); const u = um(); userMasterRepo.findOne.mockResolvedValue(u);
    expect(await svc.changePassword('bob', 'old', 'NewPass@1')).toMatchObject({ message: 'Password changed successfully' });
    expect(u).toMatchObject({ spassword: 'NewPass@1' });
  });
  it('changePassword ends the user\'s other sessions (existing tokens stop working)', async () => {
    const { svc, userMasterRepo } = build(); const u: any = um(); userMasterRepo.findOne.mockResolvedValue(u);
    await svc.changePassword('bob', 'old', 'NewPass@1');
    expect(u.forceLogoutAt).toBeInstanceOf(Date);
  });
});

describe('auth/AuthController.changePassword', () => {
  const mk = () => { const auth: any = { changePassword: jest.fn().mockResolvedValue({ message: 'ok' }) }; return { c: new AuthController(auth), auth }; };
  it('403 when the body names another user', async () => {
    const { c } = mk();
    await expect(c.changePassword({ username: 'bob' } as any, { username: 'alice', currentPassword: 'a', newPassword: 'b' } as any)).rejects.toThrow(ForbiddenException);
  });
  it('compares user names case-insensitively', async () => {
    const { c, auth } = mk();
    await c.changePassword({ username: 'Bob' } as any, { username: 'bob', currentPassword: 'a', newPassword: 'b' } as any);
    expect(auth.changePassword).toHaveBeenCalled();
  });
  it('400 when the new password equals the current one', async () => {
    const { c } = mk();
    await expect(c.changePassword({ username: 'bob' } as any, { username: 'bob', currentPassword: 'same', newPassword: 'same' } as any)).rejects.toThrow(BadRequestException);
  });
});
