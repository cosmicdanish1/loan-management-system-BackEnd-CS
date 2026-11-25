import 'reflect-metadata';
import { validate } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { UnauthorizedException, HttpException } from '@nestjs/common';
import { ILike } from 'typeorm';
import { UserMaster } from '../../../src/modules/auth/entities/user-master.entity';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { findUserMasterByName } from '../../../src/modules/auth/utils/find-user-by-name';
import { passwordPolicyError, isBcryptHash, PASSWORD_MAX, PASSWORD_MIN } from '../../../src/modules/shared/utils/password-policy';
import { ChangePasswordDto } from '../../../src/modules/auth/dto/change-password.dto';
import { CreateUserDto } from '../../../src/modules/admin/dto/create-user.dto';
import { UpdateUserDto } from '../../../src/modules/admin/dto/update-user.dto';
import { AdminChangePasswordDto } from '../../../src/modules/admin/dto/change-password.dto';
import { flattenValidationErrors } from '../../../src/common/validation/friendly-validation';

// Change Password findings ES-654 .. ES-660.

const HASH = bcrypt.hashSync('Whatever1', 4); // a real bcrypt hash (cost 4 keeps the test quick)

describe('password policy (ES-657, ES-660)', () => {
  it('knows the rule', () => { expect([PASSWORD_MIN, PASSWORD_MAX]).toEqual([8, 64]); });
  it.each([
    ['Test@1212', null], ['Test1212', null], ['Abcdef1x', null], ['a'.repeat(30) + 'A1', null], ['Aa1' + 'x'.repeat(61), null], // exactly 64
    ['abc', 'rule'], ['abcdefgh', 'rule'], ['ABCDEFG1', 'rule'], ['abcdefG', 'rule'], ['NoDigitsHere', 'rule'],
    ['Aa1' + 'x'.repeat(62), 'rule'],                                   // 65: over the maximum
    ['$2b$Abcdef1', 'rule'], ['$2a$Abcdef1', 'rule'], ['$2y$Abcdef1', 'rule'], // starts like a hash (ES-654)
    ['', 'required'], [undefined, 'required'], [123 as any, 'required'],
  ])('%j', (pw, want) => {
    const r = passwordPolicyError(pw);
    if (want === null) expect(r).toBeNull();
    else if (want === 'required') expect(r).toBe('Password is required.');
    else expect(r).toMatch(/8 to 64 characters/);
  });
  it('a $2b$ in the middle is fine', () => expect(passwordPolicyError('Ab1$2b$xyzzy')).toBeNull());
  it('a real bcrypt hash is recognised, look-alikes are not', () => {
    expect(isBcryptHash(HASH)).toBe(true);
    expect(isBcryptHash('$2b$Abcdef1')).toBe(false);
    expect(isBcryptHash('$2b$10$short')).toBe(false);
    expect(isBcryptHash('bdfh')).toBe(false);
    expect(isBcryptHash(undefined)).toBe(false);
  });
});

describe('every door uses the same policy (ES-660)', () => {
  const problems = async (o: object) => (await validate(o as any)).flatMap(e => Object.values(e.constraints || {}));
  const mk = (C: any, over: any) => Object.assign(new C(), over);
  const create = { username: 'bob', email: 'b@x.com', firstName: 'B', lastName: 'C', role: 'clerk' };

  it('Change Password, create user, admin reset and user edit accept a good password', async () => {
    expect(await problems(mk(ChangePasswordDto, { username: 'bob', currentPassword: 'x', newPassword: 'Test@1212' }))).toEqual([]);
    expect(await problems(mk(CreateUserDto, { ...create, password: 'Test@1212' }))).toEqual([]);
    expect(await problems(mk(AdminChangePasswordDto, { newPassword: 'Test@1212' }))).toEqual([]);
    expect(await problems(mk(UpdateUserDto, { password: 'Test@1212' }))).toEqual([]);
    expect(await problems(mk(UpdateUserDto, {}))).toEqual([]); // no password in an edit is fine
  });
  it.each(['abcdef', 'Abc12', 'alllowercase1', 'ALLUPPERCASE1', 'NoDigitsHere', '$2b$Abcdef1', 'Aa1' + 'x'.repeat(62)])('%j is refused by all four with the same sentence', async (pw) => {
    const lists = [
      await problems(mk(ChangePasswordDto, { username: 'bob', currentPassword: 'x', newPassword: pw })),
      await problems(mk(CreateUserDto, { ...create, password: pw })),
      await problems(mk(AdminChangePasswordDto, { newPassword: pw })),
      await problems(mk(UpdateUserDto, { password: pw })),
    ];
    for (const l of lists) { expect(l.length).toBeGreaterThan(0); expect(l.join(' ')).toMatch(/8 to 64 characters/); }
  });
  it('the API answer names the rule instead of "not in the right format"', async () => {
    const errors = await validate(mk(ChangePasswordDto, { username: 'bob', currentPassword: 'x', newPassword: 'abc' }));
    const msgs = flattenValidationErrors(errors).map(p => p.message);
    expect(msgs.join(' ')).toMatch(/8 to 64 characters with an uppercase letter/);
    expect(msgs.join(' ')).not.toMatch(/not in the right format/);
  });
  it('the old default sentences are still turned into the plain ones', async () => {
    class Plain { @(require('class-validator').Matches(/^a+$/)) code!: string; @(require('class-validator').MinLength(3)) name!: string; }
    const msgs = flattenValidationErrors(await validate(Object.assign(new Plain(), { code: 'b', name: 'x' }))).map(p => p.message);
    expect(msgs).toContain('Code is not in the right format.');
    expect(msgs).toContain('Name must be at least 3 characters.');
  });
});

describe('the entity hashes whatever a person chooses (ES-654)', () => {
  const um = (pw: string) => Object.assign(new UserMaster(), { spassword: pw });
  it('a password that starts like a hash is hashed, not stored as typed, and signs in', async () => {
    const u = um('$2b$Abcdef1'); await u.hashPassword();
    expect(u.spassword).not.toBe('$2b$Abcdef1');
    expect(isBcryptHash(u.spassword)).toBe(true);
    expect(await u.validatePassword('$2b$Abcdef1')).toBe(true);
    expect(await u.validatePassword('$2b$Abcdef2')).toBe(false);
  });
  it.each(['$2a$Abcdef1', '$2y$Abcdef1', '$2b$10$tooshort', 'plain Pass1'])('%j is hashed', async (pw) => {
    const u = um(pw); await u.hashPassword(); expect(isBcryptHash(u.spassword)).toBe(true); expect(await u.validatePassword(pw)).toBe(true);
  });
  it('a real hash is kept exactly as it is (no double hashing)', async () => {
    const u = um(HASH); await u.hashPassword(); expect(u.spassword).toBe(HASH);
    expect(await u.validatePassword('Whatever1')).toBe(true);
  });
  it('a legacy letters-only password is still hashed on the next save', async () => {
    const u = um('bdfh'); await u.hashPassword(); expect(isBcryptHash(u.spassword)).toBe(true);
  });
});

describe('finding a person by name in any letter case (ES-659)', () => {
  it('the exact spelling is one lookup', async () => {
    const repo: any = { findOne: jest.fn().mockResolvedValue({ userid: 1 }) };
    expect(await findUserMasterByName(repo, 'zz_cp1')).toEqual({ userid: 1 });
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });
  it('a miss searches ignoring case, with LIKE characters escaped', async () => {
    const repo: any = { findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ userid: 2 }) };
    expect(await findUserMasterByName(repo, 'ZZ_CP%1', ['userLevel'])).toEqual({ userid: 2 });
    const second = repo.findOne.mock.calls[1][0];
    expect(second.relations).toEqual(['userLevel']);
    expect(second.where.susername).toEqual(ILike('ZZ\\_CP\\%1'));
  });
  it('spaces around the name are ignored; empty finds nobody and asks nothing', async () => {
    const repo: any = { findOne: jest.fn().mockResolvedValue({ userid: 3 }) };
    await findUserMasterByName(repo, '  bob  ');
    expect(repo.findOne.mock.calls[0][0].where.susername).toBe('bob');
    repo.findOne.mockClear();
    expect(await findUserMasterByName(repo, '   ')).toBeNull();
    expect(await findUserMasterByName(repo, undefined as any)).toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

// A small stateful world: one stored password, a lock on the row that serialises the transactions (like FOR UPDATE).
function world() {
  const state = { hash: bcrypt.hashSync('Test@1212', 4), forceLogoutAt: null as any };
  const um: any = {
    userid: 7, susername: 'Test1212', enableDisable: 'E', userLevel: { userlevel: 'CLERK' }, email: 'b@x', permissions: [], loginStatus: 'N',
    get spassword() { return state.hash; }, set spassword(v: string) { state.hash = bcrypt.hashSync(v, 4); },
    get forceLogoutAt() { return state.forceLogoutAt; }, set forceLogoutAt(v: any) { state.forceLogoutAt = v; },
    validatePassword: async (p: string) => bcrypt.compare(p, state.hash),
  };
  let chain: Promise<unknown> = Promise.resolve();
  const lockedWith: any[] = [];
  const repo: any = {
    findOne: jest.fn(async (o: any) => (String(o.where.susername ?? '').toLowerCase().replace(/^.*\((.*)\)$/, '$1') === 'test1212' || o.where.susername === 'Test1212' || o.where.userid === 7 ? um : null)),
    find: jest.fn(async () => []), save: jest.fn(async (x: any) => x), query: jest.fn(async () => []),
  };
  repo.manager = {
    transaction: (cb: any) => {
      const run = chain.then(() => cb({
        query: async (sql: string, p: any[]) => { if (/FOR UPDATE/.test(sql)) lockedWith.push({ sql, id: p[0] }); return []; },
        findOne: async (_e: any, o: any) => (o.where.userid === 7 ? um : null),
        save: async (x: any) => x,
      }));
      chain = run.catch(() => undefined);
      return run;
    },
  };
  const jwt: any = { signAsync: jest.fn(async () => 'tok'), verify: jest.fn(), decode: jest.fn() };
  const config: any = { get: jest.fn((k: string, d?: any) => ({ JWT_SECRET: 's', JWT_REFRESH_SECRET: 'r' } as any)[k] ?? d) };
  const history = { assertNotReused: jest.fn(async () => undefined), recordHash: jest.fn(async () => undefined) };
  const svc = new AuthService(repo, {} as any, { create: (x: any) => x, save: jest.fn(), findOne: jest.fn(), find: jest.fn() } as any, {} as any, { find: async () => [] } as any, { find: async () => [] } as any, jwt, config, {} as any, history as any);
  return { svc, state, repo, history, lockedWith };
}

describe('changePassword (ES-656, ES-658, ES-659)', () => {
  it('works with the name in any letter case', async () => {
    const w = world();
    const r: any = await w.svc.changePassword('test1212', 'Test@1212', 'Other@1212');
    expect(r.message).toBe('Password changed successfully');
    expect(await bcrypt.compare('Other@1212', w.state.hash)).toBe(true);
  });
  it('takes the row under a plain FOR UPDATE lock (no join: findOne({lock}) fails on the eager relation in Postgres)', async () => {
    const w = world();
    await w.svc.changePassword('Test1212', 'Test@1212', 'Other@1212');
    expect(w.lockedWith[0].sql).toMatch(/FROM usermaster WHERE userid = \$1 FOR UPDATE/);
    expect(w.lockedWith[0].id).toBe(7);
  });
  it('an unknown name is 401', async () => {
    const w = world();
    await expect(w.svc.changePassword('nobody', 'x', 'Other@1212')).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('5 wrong current passwords lock password changes for that person (429), and a correct one is refused while locked', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) await expect(w.svc.changePassword('Test1212', 'Wrong' + i, 'Other@1212')).rejects.toThrow('Current password is incorrect');
    const e: any = await w.svc.changePassword('Test1212', 'Test@1212', 'Other@1212').catch(x => x);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(429);
    expect(JSON.stringify(e.getResponse())).toMatch(/password change attempts/);
    expect(await bcrypt.compare('Test@1212', w.state.hash)).toBe(true); // untouched
  });
  it('the lock is separate from sign-in and a success clears the count', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) await w.svc.changePassword('Test1212', 'Wrong' + i, 'Other@1212').catch(() => undefined);
    expect(() => w.svc.assertNotLocked('Test1212')).not.toThrow(); // sign-in is not locked by wrong password changes
    await w.svc.changePassword('Test1212', 'Test@1212', 'Other@1212');
    for (let i = 0; i < 4; i++) await w.svc.changePassword('Test1212', 'Wrong' + i, 'Third@1212').catch(() => undefined);
    await expect(w.svc.changePassword('Test1212', 'Other@1212', 'Third@1212')).resolves.toBeDefined(); // count started again from zero
  });
  it('stress: 10 simultaneous changes with the same current password: exactly one succeeds, the others see the new password and are refused', async () => {
    const w = world();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => w.svc.changePassword('Test1212', 'Test@1212', `Race${i}Pw@1`)));
    const ok = rs.filter(r => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const winner = rs.findIndex(r => r.status === 'fulfilled');
    expect(await bcrypt.compare(`Race${winner}Pw@1`, w.state.hash)).toBe(true);
    for (const r of rs) if (r.status === 'rejected') expect((r as any).reason.message).toBe('Current password is incorrect');
    expect(w.history.recordHash).toHaveBeenCalledTimes(1);
  });
  it('the history check runs inside the lock, before the save', async () => {
    const w = world();
    w.history.assertNotReused.mockRejectedValueOnce(new Error('reused'));
    await expect(w.svc.changePassword('Test1212', 'Test@1212', 'Old@1212x')).rejects.toThrow('reused');
    expect(await bcrypt.compare('Test@1212', w.state.hash)).toBe(true);
    expect(w.history.recordHash).not.toHaveBeenCalled();
  });
});
