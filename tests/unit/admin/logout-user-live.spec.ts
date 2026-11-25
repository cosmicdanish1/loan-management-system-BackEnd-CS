// Logout User window: live users (card list), analytics, force logout, and the working date stamped on a sign-in.
import { NotFoundException } from '@nestjs/common';
import { UserManagementService } from '../../../src/modules/admin/services/user-management.service';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { AlertBridge } from '../../../src/modules/alerts/alert-bridge';

const u = (id: number, name: string, o: any = {}) => ({
  userid: id, susername: name, enableDisable: 'E', loginStatus: 'N', firstName: null, lastName: null,
  userLevel: { userlevel: 'CLERK' }, forceLogoutAt: null, ...o,
});

function mk(users: any[], logintimeRows: any[] = [], extra: any = {}) {
  const um: any = {
    find: jest.fn().mockResolvedValue(users),
    findOne: jest.fn(async ({ where }: any) => users.find((x) => x.susername.toLowerCase() === String(where?.susername?._value ?? '').toLowerCase()) ?? null),
    save: jest.fn(async (x) => x),
    query: jest.fn(async (sql: string) => (/DISTINCT ON/.test(sql) ? logintimeRows : [])),
  };
  const open = extra.open ?? [];
  const loginRepo: any = { find: jest.fn().mockResolvedValue(open), findOne: jest.fn(), save: jest.fn(async (x) => x) };
  const svc = new UserManagementService({} as any, um, {} as any, loginRepo, {} as any, {} as any);
  return { svc, um, loginRepo };
}

const bridge = (online: string[], presence: any[] = []) => {
  const b: any = { onlineUserIds: () => new Set(online), onlineNow: () => presence, forgetPresence: jest.fn() };
  AlertBridge.set(b);
  return b;
};

afterEach(() => AlertBridge.set(undefined as any));

describe('getLiveUsers', () => {
  const uptime = jest.spyOn(process, 'uptime');
  afterAll(() => uptime.mockRestore());

  it('live users come first, then the most recently signed in; a card carries role, working date and time', async () => {
    uptime.mockReturnValue(1000);
    bridge(['2'], [{ username: 'amit', host: 'PC-2', ip: '10.0.0.2', version: '1.4.0', lastSeen: '2026-11-25T10:00:00.000Z' }]);
    const { svc } = mk(
      [u(1, 'asha'), u(2, 'amit', { loginStatus: 'Y' }), u(3, 'zed')],
      [
        { userid: 1, login_date: '2026-11-24T09:00:00', login_time: '09:00:00', logout_time: '10:00:00', working_date: '2026-08-25' },
        { userid: 2, login_date: new Date(Date.now() - 20 * 60000).toISOString(), login_time: '09:40:00', logout_time: '', working_date: '2026-08-25' },
      ],
    );
    const r = await svc.getLiveUsers();
    expect(r.users.map((x) => x.username)).toEqual(['amit', 'asha', 'zed']);
    expect(r.liveCount).toBe(1);
    expect(r.totalCount).toBe(3);
    const amit = r.users[0];
    expect(amit).toMatchObject({ live: true, role: 'CLERK', loginDate: '2026-08-25', loginTime: '09:40:00', host: 'PC-2', ip: '10.0.0.2', version: '1.4.0' });
    expect(amit.sessionMinutes).toBeGreaterThanOrEqual(19);
    expect(r.users[1]).toMatchObject({ live: false, sessionMinutes: null, logoutTime: '10:00:00' });
    expect(r.users[2]).toMatchObject({ live: false, loginTime: null, loginAt: null });
  });

  it('a user whose sign-in flag is still Y but whose app went silent is NOT live (after the restart grace period)', async () => {
    uptime.mockReturnValue(1000);
    bridge([]);
    const { svc } = mk([u(1, 'ghost', { loginStatus: 'Y' })]);
    expect((await svc.getLiveUsers()).users[0].live).toBe(false);
  });

  it('right after a backend restart (no heartbeat could arrive yet) the sign-in flag is used', async () => {
    uptime.mockReturnValue(30);
    bridge([]);
    const { svc } = mk([u(1, 'fresh', { loginStatus: 'Y' }), u(2, 'off')]);
    expect((await svc.getLiveUsers()).users.map((x) => [x.username, x.live])).toEqual([['fresh', true], ['off', false]]);
  });

  it('no presence service at all: the list still answers', async () => {
    uptime.mockReturnValue(1000);
    const { svc } = mk([u(1, 'a')]);
    expect((await svc.getLiveUsers()).users).toHaveLength(1);
  });

  it('only enabled users are asked for, and a full name is built from first and last name', async () => {
    uptime.mockReturnValue(1000);
    bridge([]);
    const { svc, um } = mk([u(1, 'a', { firstName: 'Asha', lastName: 'Rao' }), u(2, 'b', { firstName: 'Solo' })]);
    const r = await svc.getLiveUsers();
    expect(um.find).toHaveBeenCalledWith(expect.objectContaining({ where: { enableDisable: 'E' } }));
    expect(r.users.map((x) => x.fullName)).toEqual(['Asha Rao', 'Solo']);
  });

  it('500 users still return one card each (stress)', async () => {
    uptime.mockReturnValue(1000);
    bridge(Array.from({ length: 100 }, (_, i) => String(i + 1)));
    const { svc } = mk(Array.from({ length: 500 }, (_, i) => u(i + 1, 'u' + (i + 1))));
    const r = await svc.getLiveUsers();
    expect(r.users).toHaveLength(500);
    expect(r.liveCount).toBe(100);
    expect(r.users.slice(0, 100).every((x) => x.live)).toBe(true);
  });
});

describe('getSessionAnalytics', () => {
  const run = async (days: any, rows: Partial<Record<string, any>> = {}) => {
    bridge(['1', '2']);
    const um: any = {
      query: jest.fn(async (sql: string) => {
        if (/CURRENT_DATE::text/.test(sql)) return [{ d: '2026-11-25' }];
        if (/avg\(EXTRACT/.test(sql)) return [rows.totals ?? { sessions: 5, people: 2, avg_minutes: 42, never_closed: 1 }];
        if (/GROUP BY 1 ORDER BY 1/.test(sql)) return rows.perDay ?? [{ day: '2026-11-25', sessions: 3, people: 2 }, { day: '2026-11-23', sessions: 2, people: 1 }];
        if (/EXTRACT\(HOUR/.test(sql)) return rows.hours ?? [{ hour: 9, sessions: 4 }, { hour: 14, sessions: 1 }];
        if (/LIMIT 8/.test(sql)) return rows.top ?? [{ username: 'amit', sessions: 3, last_login: '2026-11-25T09:00:00Z' }];
        if (/NOT EXISTS/.test(sql)) return [{ n: 6 }];
        return [];
      }),
    };
    const svc = new UserManagementService({} as any, um, {} as any, {} as any, {} as any, {} as any);
    return { r: await svc.getSessionAnalytics(days), um };
  };

  it('totals, live count, never-signed-in and top people come from the data', async () => {
    const { r } = await run(7);
    expect(r.totals).toEqual({ sessions: 5, people: 2, avgMinutes: 42, neverClosed: 1, neverSignedIn: 6, liveNow: 2 });
    expect(r.topUsers).toEqual([{ username: 'amit', sessions: 3, lastLogin: '2026-11-25T09:00:00.000Z' }]);
  });

  it('every day of the span is present, zero where nobody signed in, oldest first', async () => {
    const { r } = await run(7);
    expect(r.perDay).toHaveLength(7);
    expect(r.perDay[0].day).toBe('2026-11-19');
    expect(r.perDay[6]).toEqual({ day: '2026-11-25', sessions: 3, people: 2 });
    expect(r.perDay.find((d) => d.day === '2026-11-24')).toEqual({ day: '2026-11-24', sessions: 0, people: 0 });
    expect(r.perDay.find((d) => d.day === '2026-11-23')?.sessions).toBe(2);
  });

  it('24 hours are always returned (zero filled)', async () => {
    const { r } = await run(30);
    expect(r.hours).toHaveLength(24);
    expect(r.hours[9].sessions).toBe(4);
    expect(r.hours[3].sessions).toBe(0);
  });

  it.each([[0, 30], [-5, 1], ['abc', 30], [9999, 365], [2.9, 2], [undefined, 30]])('days %j is used as %j', async (input, used) => {
    const { r, um } = await run(input as any);
    expect(r.days).toBe(used);
    expect(r.perDay).toHaveLength(used as number);
    expect(um.query.mock.calls.find((c: any[]) => /avg\(EXTRACT/.test(c[0]))[1]).toEqual([used]);
  });

  it('empty history: zeros, no average', async () => {
    const { r } = await run(3, { totals: { sessions: 0, people: 0, avg_minutes: null, never_closed: 0 }, perDay: [], hours: [], top: [] });
    expect(r.totals.avgMinutes).toBeNull();
    expect(r.perDay.every((d) => d.sessions === 0)).toBe(true);
    expect(r.topUsers).toEqual([]);
  });

  it('days are real calendar days of the sign-in, not the working date (which can lie months behind)', async () => {
    const { um } = await run(30);
    const sqls = um.query.mock.calls.map((c: any[]) => c[0]).join(' ');
    expect(sqls).toMatch(/login_date::date >= /);
    expect(sqls).not.toMatch(/COALESCE\(working_date/);
  });
});

describe('forceLogoutUser', () => {
  it('ends every open session with the real time, clears the flag, kills the tokens and forgets the live presence', async () => {
    const b = bridge(['5']);
    const user = u(5, 'bob', { loginStatus: 'Y' });
    const { svc, um, loginRepo } = mk([user], [], { open: [{ userid: 5, logoutTime: '' }, { userid: 5, logoutTime: '' }] });
    um.findOne.mockResolvedValue(user);
    const r = await svc.forceLogoutUser(' bob ');
    expect(r.message).toMatch(/terminated/);
    expect(user.loginStatus).toBe('N');
    expect(user.forceLogoutAt).toBeInstanceOf(Date);
    expect(loginRepo.save).toHaveBeenCalledTimes(2);
    for (const [row] of loginRepo.save.mock.calls) {
      expect(row.logoutTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(row.logoutAt).toBeInstanceOf(Date);
    }
    expect(b.forgetPresence).toHaveBeenCalledWith('5');
  });

  it('an unknown user is 404 and nothing is written', async () => {
    const { svc, um, loginRepo } = mk([]);
    um.findOne.mockResolvedValue(null);
    await expect(svc.forceLogoutUser('nobody')).rejects.toThrow(NotFoundException);
    expect(um.save).not.toHaveBeenCalled();
    expect(loginRepo.save).not.toHaveBeenCalled();
  });

  it('works when the live-presence service is not available', async () => {
    const user = u(5, 'bob');
    const { svc, um } = mk([user]);
    um.findOne.mockResolvedValue(user);
    await expect(svc.forceLogoutUser('bob')).resolves.toBeDefined();
  });
});

describe('AuthService.recordLoginSession stamps the working date', () => {
  const make = (query: jest.Mock) => {
    const created: any[] = [];
    const loginRepo: any = { manager: { query }, create: jest.fn((x) => { created.push(x); return x; }), save: jest.fn(async (x) => x) };
    const svc: any = Object.create(AuthService.prototype);
    svc.loginTimeRepository = loginRepo;
    svc.userMasterRepository = { save: jest.fn(async (x) => x) };
    svc.userInfoRepository = { findOne: jest.fn().mockResolvedValue({ userid: 1 }), save: jest.fn(), create: jest.fn((x) => x) };
    svc.logger = { warn: jest.fn() };
    return { svc, created, loginRepo };
  };

  it('uses the open Day-End working date and keeps the real moment in login_date', async () => {
    const query = jest.fn(async (sql: string) => {
      if (/to_regclass/.test(sql)) return [{ t: null }];
      if (/getworkingdate/.test(sql)) return [{ d: '2026-08-25' }];
      return [];
    });
    const { svc, created } = make(query);
    await svc.recordLoginSession({ userid: 1, loginStatus: 'N' });
    expect(created[0]).toMatchObject({ userid: 1, workingDate: '2026-08-25', logoutTime: '' });
    expect(created[0].loginDate).toBeInstanceOf(Date);
  });

  it('with the window switched to the system date it uses today (India time)', async () => {
    const query = jest.fn(async (sql: string) => {
      if (/to_regclass/.test(sql)) return [{ t: 'window_date_policy' }];
      if (/window_date_policy WHERE/.test(sql)) return [{ mode: 'SYSTEM' }];
      return [];
    });
    const { svc, created } = make(query);
    await svc.recordLoginSession({ userid: 1, loginStatus: 'N' });
    expect(created[0].workingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(query.mock.calls.some((c) => /LOGOUT_USER/.test(JSON.stringify(c[1] ?? [])))).toBe(true);
  });

  it('if the date cannot be read the sign-in is still recorded, with no working date', async () => {
    const { svc, created, loginRepo } = make(jest.fn().mockRejectedValue(new Error('db down')));
    await svc.recordLoginSession({ userid: 1, loginStatus: 'N' });
    expect(created[0].workingDate).toBeNull();
    expect(loginRepo.save).toHaveBeenCalled();
  });
});

describe('deleteUser removes the sign-in history (ids are reused)', () => {
  it('deletes the logintime rows of the deleted id', async () => {
    const user = { ...u(9, 'gone'), userLevel: { userlevel: 'CLERK' } };
    const ds: any = { query: jest.fn().mockResolvedValue([]) };
    const um: any = { findOne: jest.fn().mockResolvedValue(user), remove: jest.fn(), find: jest.fn(), query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => ({ where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(), getCount: jest.fn().mockResolvedValue(3) })) };
    const svc = new UserManagementService({} as any, um, {} as any, {} as any, ds, {} as any);
    await svc.deleteUser(9, 1);
    expect(ds.query.mock.calls.some((c: any[]) => /DELETE FROM logintime WHERE userid/.test(c[0]) && c[1][0] === 9)).toBe(true);
  });
});
