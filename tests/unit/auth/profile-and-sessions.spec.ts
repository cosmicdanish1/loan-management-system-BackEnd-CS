// My Profile endpoints (GET /auth/me, GET /auth/me/recent-logins) and the sign-in log behind them.
// ES-618: one sign-in is one row; same-day sign-ins are ordered by time.
import { NotFoundException } from '@nestjs/common';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { LocalStrategy } from '../../../src/modules/auth/strategies/local.strategy';

const um = (o: any = {}) => ({
  userid: 7, susername: 'bob', email: 'bob@x.test', userlevelid: 5, userLevel: { userlevel: 'CLERK' }, enableDisable: 'E',
  forceLogoutAt: null, hasExplicitPermissions: false, permissions: [], isEnabled: true, canPassTransactions: false,
  validatePassword: jest.fn().mockResolvedValue(true), ...o,
});

function build(over: { userMaster?: any; logins?: any[] } = {}) {
  const userMasterRepo: any = {
    findOne: jest.fn().mockResolvedValue(over.userMaster === undefined ? um() : over.userMaster),
    find: jest.fn().mockResolvedValue([]), save: jest.fn(async (x) => x), create: jest.fn((x) => ({ ...x })), query: jest.fn().mockResolvedValue([]),
  };
  const levelRepo: any = { createQueryBuilder: jest.fn(), find: jest.fn().mockResolvedValue([]), create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
  const loginRepo: any = { create: jest.fn((x) => x), save: jest.fn(async (x) => x), findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue(over.logins ?? []) };
  const infoRepo: any = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
  const rightsRepo: any = { find: jest.fn().mockResolvedValue([]) };
  const defRightsRepo: any = { find: jest.fn().mockResolvedValue([]) };
  const jwt: any = { signAsync: jest.fn(async () => 'jwt'), verify: jest.fn(), decode: jest.fn() };
  const config: any = { get: jest.fn((k: string, d?: any) => ({ JWT_SECRET: 's', JWT_REFRESH_SECRET: 'r' } as any)[k] ?? d) };
  const twofa: any = { gate: jest.fn().mockResolvedValue({ mode: 'none', required: false, enrolled: false, trusted: false }), getSettings: jest.fn().mockResolvedValue({ rememberDays: 30 }), signChallenge: jest.fn(() => 'chal') };
  const svc = new AuthService(userMasterRepo, levelRepo, loginRepo, infoRepo, rightsRepo, defRightsRepo, jwt, config, twofa,
    { assertNotReused: async () => undefined, recordHash: async () => undefined, recordCurrent: async () => undefined } as any);
  return { svc, userMasterRepo, loginRepo, twofa };
}

describe('AuthService.getMyRecentLogins (My Profile > Recent activity)', () => {
  const rows = [
    { loginDate: new Date('2026-11-22T10:00:00Z'), loginTime: '15:30:12', logoutTime: '' },
    { loginDate: new Date('2026-11-21T04:00:00Z'), loginTime: '09:30:00', logoutTime: '17:45:00' },
  ];

  it('returns the caller\'s own rows, newest first, with an active flag', async () => {
    const { svc, loginRepo } = build({ logins: rows });
    const res = await svc.getMyRecentLogins(7, 5);
    expect(loginRepo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { userid: 7 }, take: 5 }));
    expect(res).toEqual([
      { loginDate: rows[0]!.loginDate, loginTime: '15:30:12', logoutTime: null, active: true },
      { loginDate: rows[1]!.loginDate, loginTime: '09:30:00', logoutTime: '17:45:00', active: false },
    ]);
  });

  it.each([[undefined, 5], [0, 5], [-3, 5], [NaN, 5], [3, 3], [20, 20], [500, 20], [2.8, 2]])('limit %p is read as %p', async (limit, take) => {
    const { svc, loginRepo } = build();
    await svc.getMyRecentLogins(7, limit as any);
    expect(loginRepo.find.mock.calls[0][0].take).toBe(take);
  });

  it('is always for the signed-in user id it is given', async () => {
    const { svc, loginRepo } = build();
    await svc.getMyRecentLogins(42, 5);
    expect(loginRepo.find.mock.calls[0][0].where).toEqual({ userid: 42 });
  });

  it('two sign-ins on the same day are ordered by time too (newest first), not only by date', async () => {
    const { svc, loginRepo } = build();
    await svc.getMyRecentLogins(7, 5);
    expect(loginRepo.find.mock.calls[0][0].order).toEqual({ loginDate: 'DESC', loginTime: 'DESC' });
  });
});

describe('AuthService.getCurrentUser (GET /auth/me)', () => {
  it('returns the profile of the signed-in user', async () => {
    const { svc, userMasterRepo } = build();
    const me = await svc.getCurrentUser(7);
    expect(userMasterRepo.findOne).toHaveBeenCalledWith({ where: { userid: 7 } });
    expect(me.username).toBe('bob');
  });
  it('a missing user is "not found"', async () => {
    await expect(build({ userMaster: null }).svc.getCurrentUser(7)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('a disabled user is "not found"', async () => {
    await expect(build({ userMaster: um({ isEnabled: false }) }).svc.getCurrentUser(7)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('One sign-in is one row in the sign-in log', () => {
  it('validateUser alone records nothing (it only checks the password)', async () => {
    const { svc, loginRepo } = build();
    await svc.validateUser('bob', 'pw');
    expect(loginRepo.save).not.toHaveBeenCalled();
  });

  // The login route runs the passport strategy (password check #1) and then AuthService.login (password check #2).
  it('the full login route (strategy + login) records ONE session, not two', async () => {
    const { svc, loginRepo } = build();
    const strategy = new LocalStrategy(svc);
    const user = await strategy.validate('bob', 'pw');   // what the passport guard does
    expect(user).toBeTruthy();
    await svc.login({ username: 'bob', password: 'pw' } as any); // what the controller then calls
    expect(loginRepo.save).toHaveBeenCalledTimes(1);
  });
});
