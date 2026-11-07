import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AppCodeService, APPCODE_MAX_WRONG } from '../../../src/modules/mobile/access/app-code.service';
import { SessionService } from '../../../src/modules/mobile/access/session.service';
import { MemberAuthService, MAX_MPIN_TRIES } from '../../../src/modules/mobile/access/member-auth.service';
import { generateSecret, hotp, currentStep } from '../../../src/modules/auth/twofa/totp.util';
import { sha256 } from '../../../src/modules/mobile/access/mobile-crypto';

/** Phase 9 (previously untested): the member mobile app's App Code, refresh-token sessions and MPIN sign-in. */
const NOW = Date.UTC(2026, 10, 3, 6, 0, 0);

describe('mobile AppCodeService.check', () => {
  const secret = generateSecret();
  const mk = (device: any) => {
    const rows = { ...device };
    const ds: any = { query: jest.fn(async (sql: string, p: any[] = []) => {
      if (/^SELECT appcode_secret_enc/.test(sql.trim())) return device === null ? [] : [{ ...rows }];
      if (/SET appcode_wrong = \$2, appcode_locked_until = \$3/.test(sql)) { rows.appcode_wrong = p[1]; rows.appcode_locked_until = p[2]; return []; }
      if (/SET appcode_wrong = 0, appcode_locked_until = NULL, appcode_last_step = \$2/.test(sql)) { rows.appcode_wrong = 0; rows.appcode_locked_until = null; rows.appcode_last_step = p[1]; return []; }
      return [];
    }) };
    const crypto: any = { decrypt: (v: string) => v.replace(/^enc:/, '') };
    return { svc: new AppCodeService(ds, crypto, new JwtService({ secret: 's' }), { log: jest.fn() } as any), rows, ds };
  };
  const dev = (o: any = {}) => ({ appcode_secret_enc: 'enc:' + secret, appcode_wrong: 0, appcode_last_step: null, appcode_locked_until: null, ...o });
  const stepNow = currentStep(NOW);

  it('no device or no secret: no_secret', async () => { expect(await mk(null).svc.check(1, '5', '123456', NOW)).toBe('no_secret'); expect(await mk(dev({ appcode_secret_enc: null })).svc.check(1, '5', '123456', NOW)).toBe('no_secret'); });
  it('a right code is ok once; the same step again is a replay; an older step than the last one is a replay too', async () => {
    const t = mk(dev());
    expect(await t.svc.check(1, '5', hotp(secret, stepNow), NOW)).toBe('ok');
    expect(await t.svc.check(1, '5', hotp(secret, stepNow), NOW)).toBe('replay');
    expect(await t.svc.check(1, '5', hotp(secret, stepNow - 1), NOW)).toBe('replay');
    expect(await t.svc.check(1, '5', hotp(secret, stepNow + 1), NOW)).toBe('ok');
  });
  it('wrong codes count; the 5th locks for 15 minutes (counter reset); while locked even a right code is refused; after the lock it works', async () => {
    const t = mk(dev());
    for (let i = 1; i < APPCODE_MAX_WRONG; i++) expect(await t.svc.check(1, '5', '000000', NOW)).toBe('wrong');
    expect(t.rows.appcode_wrong).toBe(APPCODE_MAX_WRONG - 1);
    expect(await t.svc.check(1, '5', '000000', NOW)).toBe('locked');
    expect(t.rows.appcode_wrong).toBe(0);
    expect(await t.svc.check(1, '5', hotp(secret, stepNow), NOW + 60_000)).toBe('locked');
    expect(await t.svc.check(1, '5', hotp(secret, currentStep(NOW + 16 * 60_000)), NOW + 16 * 60_000)).toBe('ok');
  });
  it('a replayed (already used) code does not count as a wrong attempt', async () => {
    const t = mk(dev({ appcode_last_step: stepNow, appcode_wrong: 2 }));
    expect(await t.svc.check(1, '5', hotp(secret, stepNow), NOW)).toBe('replay'); expect(t.rows.appcode_wrong).toBe(2);
  });
  it('text, short and long codes are wrong, never ok', async () => { for (const c of ['abcdef', '12345', '1234567', '', '12 34 56']) expect(await mk(dev()).svc.check(1, '5', c, NOW)).toBe('wrong'); });
});

describe('mobile AppCodeService.stepUp / requireApproval', () => {
  const secret = generateSecret();
  const build = () => {
    const rows: any = { appcode_secret_enc: 'enc:' + secret, appcode_wrong: 0, appcode_last_step: null, appcode_locked_until: null };
    const ds: any = { query: jest.fn(async (sql: string, p: any[] = []) => (/^SELECT appcode_secret_enc/.test(sql.trim()) ? [{ ...rows }] : (rows.appcode_last_step = /last_step = \$2/.test(sql) ? p[1] : rows.appcode_last_step, []))) };
    const svc = new AppCodeService(ds, { decrypt: (v: string) => v.replace(/^enc:/, '') } as any, new JwtService({ secret: 'jwt-secret' }), { log: jest.fn() } as any);
    return svc;
  };
  const member = { mbno: '5', deviceId: 9 }; const ctx: any = {};
  it('an unknown action is refused, a wrong code is 401, a locked check is 403', async () => {
    const svc = build();
    await expect(svc.stepUp(member, 'DELETE_EVERYTHING', '123456', ctx)).rejects.toBeInstanceOf(HttpException);
    await expect(svc.stepUp(member, 'CHANGE_MPIN', '000000', ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('an approval covers only the member, phone and action it was given for', async () => {
    const svc = build(); const code = hotp(secret, currentStep());
    const { approval } = await svc.stepUp(member, 'CHANGE_MPIN', code, ctx);
    await expect(svc.requireApproval(member, 'CHANGE_MPIN', approval)).resolves.toBeUndefined();
    for (const [m, a] of [[{ mbno: '6', deviceId: 9 }, 'CHANGE_MPIN'], [{ mbno: '5', deviceId: 10 }, 'CHANGE_MPIN'], [member, 'DEACTIVATE_ACCESS']] as any[]) await expect(svc.requireApproval(m, a, approval)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.requireApproval(member, 'CHANGE_MPIN', undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.requireApproval(member, 'CHANGE_MPIN', 'garbage')).rejects.toBeInstanceOf(ForbiddenException);
    const loginToken = new JwtService({ secret: 'jwt-secret' }).sign({ mbno: '5', did: 9, act: 'CHANGE_MPIN' }); // an access-style token without the step-up type
    await expect(svc.requireApproval(member, 'CHANGE_MPIN', loginToken)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('mobile SessionService.rotate', () => {
  const mk = (row: any | null, claimed = true) => {
    const calls: Array<[string, any[]]> = [];
    const ds: any = { query: jest.fn(async (sql: string, p: any[] = []) => {
      calls.push([sql.replace(/\s+/g, ' ').trim(), p]);
      if (/FROM mobile_session s JOIN mobile_device d ON d.id = s.device_id LEFT JOIN/.test(calls[calls.length - 1][0])) return row ? [row] : [];
      if (/SET used_at = now\(\) WHERE id = \$1 AND used_at IS NULL/.test(calls[calls.length - 1][0])) return claimed ? [{ id: 1 }] : [];
      return [];
    }) };
    const tokens: any = { signAccess: jest.fn().mockResolvedValue(new JwtService({ secret: 'x' }).sign({ a: 1 }, { expiresIn: '15m' })) };
    const crypto: any = { newRefreshToken: () => 'new-refresh' };
    const svc = new SessionService(ds, tokens, new JwtService({ secret: 'x' }), crypto, { get: (_k: string, d: any) => d } as any);
    return { svc, calls };
  };
  const good = (o: any = {}) => ({ id: 1, mbno: '5', device_id: 9, family_id: 'fam', used_at: null, revoked_at: null, expired: false, device_id_hash: sha256('dev'), device_revoked: false, status: 'ACTIVE', too_old: false, ...o });
  const code = async (p: Promise<any>) => (await p.catch((e: any) => e)).getResponse?.().code;

  it('a good token rotates: a new pair in the same family', async () => {
    const t = mk(good()); const r = await t.svc.rotate('tok', sha256('dev'));
    expect(r).toMatchObject({ mbno: '5', deviceId: 9, familyId: 'fam', refreshToken: 'new-refresh' });
    expect(t.calls.some(([s, p]) => /INSERT INTO mobile_session/.test(s) && p[2] === 'fam')).toBe(true);
  });
  it('unknown token, wrong phone, expired, revoked device, inactive account and a signed-out token are all REFRESH_INVALID', async () => {
    expect(await code(mk(null).svc.rotate('t', sha256('dev')))).toBe('REFRESH_INVALID');
    for (const o of [{ device_id_hash: 'other' }, { expired: true }, { device_revoked: true }, { status: 'BLOCKED' }, { status: 'LOCKED' }, { revoked_at: new Date() }]) expect(await code(mk(good(o)).svc.rotate('t', sha256('dev')))).toBe('REFRESH_INVALID');
  });
  it('a token used twice kills its whole family (REFRESH_REUSED); so does losing the claim race', async () => {
    for (const t of [mk(good({ used_at: new Date() })), mk(good(), false)]) {
      expect(await code(t.svc.rotate('t', sha256('dev')))).toBe('REFRESH_REUSED');
      expect(t.calls.some(([s, p]) => /SET revoked_at = now\(\) WHERE family_id = \$1/.test(s) && p[0] === 'fam')).toBe(true);
    }
  });
  it('a family older than the absolute limit is killed and asks for a new sign-in (SESSION_EXPIRED)', async () => {
    const t = mk(good({ too_old: true })); expect(await code(t.svc.rotate('t', sha256('dev')))).toBe('SESSION_EXPIRED');
    expect(t.calls.some(([s]) => /SET revoked_at = now\(\) WHERE family_id/.test(s))).toBe(true);
  });
  it('an empty or missing refresh token is looked up as the hash of an empty string, not as null', async () => {
    const t = mk(null); await code(t.svc.rotate(undefined as any, sha256('dev')));
    expect(t.calls[0][1][0]).toBe(sha256(''));
  });
});

describe('mobile MemberAuthService.login', () => {
  const dev = 'device-1';
  const acct = (o: any = {}) => ({ mbno: '5', status: 'ACTIVE', mpin_hash: bcrypt.hashSync('1234', 4), failed_attempts: 0, wait_seconds: 0, device_id: 9, revoked: false, ...o });
  const mk = (row: any | null) => {
    const updates: any[] = [];
    const ds: any = { query: jest.fn(async (sql: string, p: any[] = []) => { if (/^SELECT a\.mbno/.test(sql.trim())) return row ? [row] : []; updates.push([sql.replace(/\s+/g, ' ').trim(), p]); return []; }) };
    const sessions: any = { start: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 }) };
    const audit: any = { log: jest.fn() };
    return { svc: new MemberAuthService(ds, sessions, audit), ds, updates, sessions, audit };
  };
  const status = async (p: Promise<any>) => (await p.catch((e: any) => e)).getStatus?.() ?? (await Promise.resolve(0));
  const resp = async (p: Promise<any>) => (await p.catch((e: any) => e)).getResponse?.();

  it('the right MPIN signs in, resets the counters and starts a session', async () => {
    const t = mk(acct()); const r = await t.svc.login({ mbno: '5', mpin: '1234', deviceId: dev }, {} as any);
    expect(r).toMatchObject({ accessToken: 'a', mbno: '5' }); expect(t.updates.some(([s]) => /failed_attempts = 0, locked_until = NULL/.test(s))).toBe(true);
  });
  it('unknown member, unknown phone, revoked phone and not-activated accounts all answer the same INVALID_CREDENTIALS', async () => {
    for (const row of [null, acct({ device_id: null }), acct({ revoked: true }), acct({ status: 'NOT_ACTIVATED' }), acct({ status: 'DEACTIVATED' }), acct({ status: 'REQUEST_PENDING' })]) {
      const r = await resp(mk(row).svc.login({ mbno: '5', mpin: '1234', deviceId: dev }, {} as any)); expect(r.code).toBe('INVALID_CREDENTIALS');
    }
  });
  it('a member number that is not digits is looked up as 0 (never reaches the query as text)', async () => {
    const t = mk(null); await resp(t.svc.login({ mbno: "5' OR '1'='1", mpin: '1', deviceId: dev }, {} as any));
    expect(t.ds.query.mock.calls[0][1][0]).toBe('0');
  });
  it('blocked = 403, locked = 423, waiting after a wrong MPIN = 429 with the seconds', async () => {
    expect((await resp(mk(acct({ status: 'BLOCKED' })).svc.login({ mbno: '5', mpin: '1234', deviceId: dev }, {} as any))).code).toBe('ACCESS_BLOCKED');
    expect((await resp(mk(acct({ status: 'LOCKED' })).svc.login({ mbno: '5', mpin: '1234', deviceId: dev }, {} as any))).code).toBe('MPIN_LOCKED');
    const w = await resp(mk(acct({ wait_seconds: 30 })).svc.login({ mbno: '5', mpin: '1234', deviceId: dev }, {} as any)); expect(w).toMatchObject({ code: 'MPIN_DELAY', retryAfterSeconds: 30 });
  });
  it('wrong MPIN counts attempts, tells how many are left, delays after the 3rd and 4th and locks on the 5th; the right MPIN is not checked while delayed', async () => {
    const left = await resp(mk(acct({ failed_attempts: 1 })).svc.login({ mbno: '5', mpin: '0000', deviceId: dev }, {} as any)); expect(left).toMatchObject({ code: 'INVALID_CREDENTIALS', attemptsLeft: MAX_MPIN_TRIES - 2 });
    const third = mk(acct({ failed_attempts: 2 })); await resp(third.svc.login({ mbno: '5', mpin: '0000', deviceId: dev }, {} as any));
    expect(third.updates[0][1]).toEqual(['5', 3, false, 30]);
    const fourth = mk(acct({ failed_attempts: 3 })); await resp(fourth.svc.login({ mbno: '5', mpin: '0000', deviceId: dev }, {} as any)); expect(fourth.updates[0][1]).toEqual(['5', 4, false, 60]);
    const fifth = mk(acct({ failed_attempts: 4 })); const l = await resp(fifth.svc.login({ mbno: '5', mpin: '0000', deviceId: dev }, {} as any));
    expect(l.code).toBe('MPIN_LOCKED'); expect(fifth.updates[0][1]).toEqual(['5', 5, true, 0]);
  });
  it('an account with no MPIN set can never sign in, whatever is typed', async () => {
    for (const pin of ['', '0000', 'null', 'undefined']) expect((await resp(mk(acct({ mpin_hash: null })).svc.login({ mbno: '5', mpin: pin, deviceId: dev }, {} as any))).code).toBe('INVALID_CREDENTIALS');
  });
});
