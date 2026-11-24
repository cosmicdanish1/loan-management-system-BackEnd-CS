import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserManagementService } from '../../../src/modules/admin/services/user-management.service';
import { MENUID_TO_ACTION, MENU_ACTION_MAP } from '../../../src/modules/auth/menu-action-map';

// Create / Modify Users (ES-645..648): window rights per user, working date stamp, who may hand out the top levels.

interface Opts {
  working?: string | null;            // Day-End working date (open getworkingdate row)
  policy?: 'WORKING' | 'SYSTEM';
  levelName?: string;                 // level of the user being edited
  defaults?: number[];                // level default rights
  own?: number[];                     // the user's own rights
  menus?: number[];                   // ids that exist in menumaster
  actorLevel?: string;
  taken?: boolean;
}

const build = (o: Opts = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const menus = o.menus ?? [1, 2, 3, 13, 67];
  const answer = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    if (/JOIN userlevelmaster/.test(sql)) return [{ userlevel: o.actorLevel ?? 'ADMINISTRATOR' }];
    if (/FROM userleveldefaultrights/.test(sql)) return (o.defaults ?? [1, 2]).map(menuid => ({ menuid }));
    if (/SELECT menuid FROM userrights/.test(sql)) return (o.own ?? []).map(menuid => ({ menuid }));
    if (/SELECT menuid, menuname, menudesc FROM menumaster/.test(sql)) return menus.map(menuid => ({ menuid, menuname: 'm' + menuid, menudesc: 'Menu ' + menuid }));
    if (/SELECT menuid FROM menumaster WHERE menuid = ANY/.test(sql)) return (params![0] as number[]).filter(i => menus.includes(i)).map(menuid => ({ menuid }));
    if (sql.includes('to_regclass')) return o.policy ? [{ t: 'window_date_policy' }] : [{ t: null }];
    if (sql.includes('FROM window_date_policy WHERE window_key')) return o.policy ? [{ mode: o.policy }] : [];
    if (sql.includes("FROM getworkingdate WHERE dayend_flag = 'N'")) return o.working ? [{ d: o.working }] : [];
    if (/MAX\(userid\)/.test(sql)) return [{ next_id: 90 }];
    return [];
  };
  const qr: any = {
    connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
    query: jest.fn(answer), manager: { create: jest.fn((_e: any, x: any) => ({ ...x, permissions: [] })), save: jest.fn(async (x: any) => x) },
  };
  const ds: any = { createQueryRunner: jest.fn(() => qr), query: jest.fn(answer) };
  const target = { userid: 7, susername: 'bob', userlevelid: 5, userLevel: { userlevel: o.levelName ?? 'CLERK', userlevelid: 5 }, enableDisable: 'E', email: 'b@x.com', firstName: 'B', lastName: 'C',
    hasExplicitPermissions: false, permissions: [], isEnabled: true, canPassTransactions: false, fullName: 'B C', dateOfCreation: new Date(), dateOfDisableEnable: null as any, forceLogoutAt: null };
  const qb: any = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(), getCount: jest.fn().mockResolvedValue(o.taken ? 1 : 0),
    getOne: jest.fn().mockResolvedValue({ userlevelid: 5, userlevel: 'CLERK' }) };
  const um: any = { findOne: jest.fn().mockResolvedValue(target), save: jest.fn(async (x: any) => x), remove: jest.fn(), createQueryBuilder: jest.fn(() => qb), find: jest.fn().mockResolvedValue([]) };
  const levelRepo: any = { createQueryBuilder: jest.fn(() => qb), find: jest.fn().mockResolvedValue([]), create: jest.fn((x: any) => x), save: jest.fn() };
  const svc = new UserManagementService({} as any, um, levelRepo, {} as any, ds, { assertNotReused: async () => undefined, recordHash: async () => undefined } as any);
  return { svc, um, qr, ds, calls, target, qb, levelRepo };
};
const cu = (o: any = {}) => ({ username: 'new', password: 'Abcdef1!', role: 'clerk', ...o }) as any;
const rightsInserts = (calls: any[]) => calls.filter(c => /INSERT INTO userrights/.test(c.sql));

describe('who may hand out the top levels (ES-647)', () => {
  it.each([
    ['an administrator cannot create a SYSTEM user', { role: 'administrator' }, 'system', /SYSTEM/],
    ['a clerk cannot create an administrator', { role: 'clerk' }, 'administrator', /ADMINISTRATOR/],
    ['nobody (no actor) cannot create an administrator', undefined, 'administrator', /ADMINISTRATOR/],
  ])('%s', async (_n, actor, role, text) => {
    const { svc, qr } = build();
    await expect(svc.createUser(cu({ role }), actor as any)).rejects.toThrow(text as RegExp);
    await expect(svc.createUser(cu({ role }), actor as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(qr.manager.save).not.toHaveBeenCalled();
  });
  it('a SYSTEM user can create SYSTEM and administrator users; an administrator can create an administrator', async () => {
    for (const [actor, role] of [['system', 'system'], ['system', 'administrator'], ['administrator', 'administrator'], ['administrator', 'clerk']] as const) {
      const { svc, um } = build(); um.findOne.mockResolvedValue(null);
      await expect(svc.createUser(cu({ role }), { role: actor })).resolves.toBeDefined();
    }
  });
  it('changing a level through update is checked against the acting user read from the account', async () => {
    const lowActor = build({ actorLevel: 'CLERK' });
    await expect(lowActor.svc.updateUser(7, { role: 'administrator' } as any, 99)).rejects.toBeInstanceOf(ForbiddenException);
    const adminActor = build({ actorLevel: 'ADMINISTRATOR' });
    await expect(adminActor.svc.updateUser(7, { role: 'system' } as any, 99)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(adminActor.svc.updateUserRole(7, { role: 'system' } as any, 99)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('user name rules (ES-649)', () => {
  it('spaces around the name are cut, and the trimmed name is what is stored', async () => {
    const { svc, um, qr } = build(); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu({ username: '  Test123  ' }), { role: 'administrator' });
    expect(qr.manager.create.mock.calls[0][1].susername).toBe('Test123');
  });
  it.each([
    ['empty', '   ', /required/],
    ['21 characters (the legacy column holds 20)', 'a'.repeat(21), /at most 20/],
    ['a space inside', 'two words', /letters, digits/],
    ['an @ sign', 'bob@home', /letters, digits/],
    ['non-ASCII letters', 'rām', /letters, digits/],
  ])('refuses %s with a 400 before anything is written', async (_n, username, text) => {
    const { svc, qr } = build();
    const p = svc.createUser(cu({ username }), { role: 'administrator' });
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow(text as RegExp);
    expect(qr.manager.save).not.toHaveBeenCalled();
  });
  it('exactly 20 characters and . _ - are fine', async () => {
    const { svc, um } = build(); um.findOne.mockResolvedValue(null);
    await expect(svc.createUser(cu({ username: 'a.b_c-d' + 'x'.repeat(13) }), { role: 'administrator' })).resolves.toBeDefined();
  });
  it('a new name on update is checked the same way', async () => {
    const { svc } = build();
    await expect(svc.updateUser(7, { username: 'bad name' } as any, 99)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updateUser(7, { username: 'z'.repeat(25) } as any, 99)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('creation and enable / disable date (ES-646)', () => {
  it('a new user is stamped with the Day-End working date as a date only, in both date columns', async () => {
    const { svc, um, qr } = build({ working: '2026-08-25' }); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu(), { role: 'administrator' });
    const rec = qr.manager.create.mock.calls[0][1];
    expect(rec.dateOfCreation.getFullYear()).toBe(2026);
    expect([rec.dateOfCreation.getMonth(), rec.dateOfCreation.getDate()]).toEqual([7, 25]);
    expect([rec.dateOfCreation.getHours(), rec.dateOfCreation.getMinutes(), rec.dateOfCreation.getSeconds()]).toEqual([0, 0, 0]);
    expect(rec.dateOfDisableEnable).toEqual(rec.dateOfCreation);
  });
  it('with the window set to the system date the system date is used (date only)', async () => {
    const { svc, um, qr } = build({ working: '2026-08-25', policy: 'SYSTEM' }); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu(), { role: 'administrator' });
    const d: Date = qr.manager.create.mock.calls[0][1].dateOfCreation;
    const now = new Date();
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([now.getFullYear(), now.getMonth(), now.getDate()]);
    expect(d.getHours()).toBe(0);
  });
  it('with no working date at all, today as a date only', async () => {
    const { svc, um, qr } = build({ working: null }); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu(), { role: 'administrator' });
    expect(qr.manager.create.mock.calls[0][1].dateOfCreation.getHours()).toBe(0);
  });
  it('disabling or enabling stamps the date of the change; an edit that does not change it leaves the date alone', async () => {
    const a = build({ working: '2026-08-25' });
    await a.svc.updateUser(7, { isActive: false } as any, 99);
    const saved = a.um.save.mock.calls[0][0];
    expect(saved.enableDisable).toBe('D');
    expect([saved.dateOfDisableEnable.getMonth(), saved.dateOfDisableEnable.getDate()]).toEqual([7, 25]);
    const b = build({ working: '2026-08-25' });
    await b.svc.updateUser(7, { isActive: true, firstName: 'X' } as any, 99);
    expect(b.um.save.mock.calls[0][0].dateOfDisableEnable).toBeNull();
  });
  it('the window is listed in Day-End > Date settings and wired', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DATE_POLICY_WINDOWS } = require('../../../src/modules/admin/date-policy-windows');
    expect(DATE_POLICY_WINDOWS.find((w: any) => w.key === 'USER_MANAGEMENT')).toMatchObject({ kind: 'stores', wired: true });
  });
});

describe('window rights of one user (ES-645)', () => {
  it('shows what the user has, the level defaults and every window', async () => {
    const { svc } = build({ own: [3, 13], defaults: [1, 2] });
    const r = await svc.getUserMenuRights(7);
    expect(r).toMatchObject({ userid: 7, custom: true, granted: [3, 13], defaults: [1, 2], unrestricted: false });
    expect(r.menus).toHaveLength(5);
  });
  it('a user with none of their own starts from the level defaults', async () => {
    const { svc } = build({ own: [], defaults: [1, 2] });
    expect(await svc.getUserMenuRights(7)).toMatchObject({ custom: false, granted: [1, 2] });
  });
  it('an administrator is shown as unrestricted', async () => {
    const { svc } = build({ levelName: 'ADMINISTRATOR' });
    expect((await svc.getUserMenuRights(7)).unrestricted).toBe(true);
  });
  it('unknown user is a 404', async () => {
    const { svc, um } = build(); um.findOne.mockResolvedValue(null);
    await expect(svc.getUserMenuRights(99)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setUserMenuRights(99, [1])).rejects.toBeInstanceOf(NotFoundException);
  });
  it('saves replace the rights in one transaction under a per-user lock, each window once', async () => {
    const { svc, qr } = build();
    const r = await svc.setUserMenuRights(7, [1, 3, 3, 13]);
    expect(r).toEqual({ userid: 7, count: 3 });
    const sqls = qr.query.mock.calls.map((c: any[]) => c[0]);
    expect(sqls.findIndex((s: string) => /pg_advisory_xact_lock/.test(s))).toBeLessThan(sqls.findIndex((s: string) => /DELETE FROM userrights/.test(s)));
    expect(qr.query.mock.calls.find((c: any[]) => /INSERT INTO userrights/.test(c[0]))[1]).toEqual([7, [1, 3, 13]]);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });
  it.each([
    ['not a list', 'x', /list of window ids/],
    ['text ids', ['a'], /list of window ids/],
    ['negative ids', [-1], /list of window ids/],
    ['fractions', [1.5], /list of window ids/],
    ['unknown windows, named', [1, 9999], /Unknown window right: 9999/],
    ['an empty list', [], /at least one window right/],
  ])('refuses %s with a 400 and writes nothing', async (_n, body, text) => {
    const { svc, qr } = build();
    const p = svc.setUserMenuRights(7, body as any);
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow(text as RegExp);
    expect(rightsInserts(qr.query.mock.calls.map((c: any[]) => ({ sql: c[0] })))).toHaveLength(0);
    expect(qr.startTransaction).not.toHaveBeenCalled();
  });
  it('administrators and SYSTEM users have every right, so setting theirs is refused', async () => {
    for (const levelName of ['ADMINISTRATOR', 'SYSTEM']) {
      const { svc } = build({ levelName });
      await expect(svc.setUserMenuRights(7, [1])).rejects.toThrow(/always have every right/);
    }
  });
  it('a failed insert rolls back and releases', async () => {
    const { svc, qr } = build();
    const orig = qr.query.getMockImplementation();
    qr.query.mockImplementation(async (sql: string, p: any[]) => { if (/INSERT INTO userrights/.test(sql)) throw new Error('boom'); return orig(sql, p); });
    await expect(svc.setUserMenuRights(7, [1])).rejects.toThrow('boom');
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });
  it('a new user gets the rights chosen on the screen, else the level defaults', async () => {
    const a = build({ defaults: [1, 2] }); a.um.findOne.mockResolvedValue(null);
    await a.svc.createUser(cu({ menuIds: [3, 13] }), { role: 'administrator' });
    expect(a.qr.query.mock.calls.find((c: any[]) => /INSERT INTO userrights/.test(c[0]))[1][1]).toEqual([3, 13]);
    const b = build({ defaults: [1, 2] }); b.um.findOne.mockResolvedValue(null);
    await b.svc.createUser(cu(), { role: 'administrator' });
    expect(b.qr.query.mock.calls.find((c: any[]) => /INSERT INTO userrights/.test(c[0]))[1][1]).toEqual([1, 2]);
  });
  it('an unknown window on create is a 400 before the user exists', async () => {
    const { svc, um, qr } = build(); um.findOne.mockResolvedValue(null);
    await expect(svc.createUser(cu({ menuIds: [9999] }), { role: 'administrator' })).rejects.toBeInstanceOf(BadRequestException);
    expect(qr.manager.save).not.toHaveBeenCalled();
  });
  it('changing the level resets the rights to the new level defaults (legacy), unless rights are sent with it', async () => {
    const a = build({ defaults: [1, 2] }); a.levelRepo.find.mockResolvedValue([]);
    a.qb.getOne.mockResolvedValue({ userlevelid: 6, userlevel: 'AUDITOR' });
    await a.svc.updateUser(7, { role: 'auditor' } as any, 99);
    expect(a.qr.query.mock.calls.find((c: any[]) => /INSERT INTO userrights/.test(c[0]))[1]).toEqual([7, [1, 2]]);
    const b = build({ defaults: [1, 2] });
    b.qb.getOne.mockResolvedValue({ userlevelid: 6, userlevel: 'AUDITOR' });
    await b.svc.updateUser(7, { role: 'auditor', menuIds: [3] } as any, 99);
    expect(b.qr.query.mock.calls.find((c: any[]) => /INSERT INTO userrights/.test(c[0]))[1]).toEqual([7, [3]]);
  });
  it('rights sent with an edit that keeps the level replace the current ones; an empty list is refused', async () => {
    const a = build();
    await a.svc.updateUser(7, { firstName: 'X', menuIds: [1, 13] } as any, 99);
    expect(a.qr.query.mock.calls.find((c: any[]) => /INSERT INTO userrights/.test(c[0]))[1]).toEqual([7, [1, 13]]);
    const b = build();
    await expect(b.svc.updateUser(7, { menuIds: [] } as any, 99)).rejects.toThrow(/at least one window right/);
  });
  it('an edit with no rights and no level change leaves the rights alone', async () => {
    const { svc, qr } = build();
    await svc.updateUser(7, { firstName: 'X' } as any, 99);
    expect(qr.query.mock.calls.some((c: any[]) => /userrights/.test(c[0]))).toBe(false);
  });
  it('stress: 100 simultaneous saves of one user all commit under the lock', async () => {
    const { svc, qr } = build();
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => svc.setUserMenuRights(7, i % 2 ? [1, 2] : [3, 13])));
    expect(rs.every(r => r.count === 2)).toBe(true);
    expect(qr.commitTransaction).toHaveBeenCalledTimes(100);
    expect(qr.query.mock.calls.filter((c: any[]) => /pg_advisory_xact_lock/.test(c[0]))).toHaveLength(100);
  });
});

describe('deleting a user removes their window rights (ES-651)', () => {
  it('the rights rows go with the person', async () => {
    const { svc, calls } = build();
    await svc.deleteUser(7, 99);
    expect(calls.some(c => /DELETE FROM userrights WHERE userid = \$1/.test(c.sql) && c.params![0] === 7)).toBe(true);
  });
  it('a new person always starts with a clean set, even when the level has no defaults (reused ids)', async () => {
    const { svc, um, qr } = build({ defaults: [] }); um.findOne.mockResolvedValue(null);
    await svc.createUser(cu(), { role: 'administrator' });
    expect(qr.query.mock.calls.some((c: any[]) => /DELETE FROM userrights WHERE userid = \$1/.test(c[0]) && c[1][0] === 90)).toBe(true);
  });
  it('a failure removing the rights never turns a deleted user into an error', async () => {
    const { svc, ds } = build();
    ds.query.mockImplementation(async (sql: string) => { if (/DELETE FROM userrights/.test(sql)) throw new Error('boom'); return []; });
    await expect(svc.deleteUser(7, 99)).resolves.toEqual({ message: 'User deleted successfully' });
  });
  it('nothing is removed when the delete itself is refused (own account)', async () => {
    const { svc, calls } = build();
    await expect(svc.deleteUser(7, 7)).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls.some(c => /DELETE FROM userrights/.test(c.sql))).toBe(false);
  });
});

describe('menu map (ES-648)', () => {
  it('every window has its own menu id (RD/CD Interest no longer shares 250)', () => {
    const ids = MENU_ACTION_MAP.map(m => m.menuid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MENUID_TO_ACTION.get(250)).toBe('COMPULSORY_DEPOSIT_LEGACY');
    expect(MENUID_TO_ACTION.get(251)).toBe('RD_INTEREST');
  });
});
