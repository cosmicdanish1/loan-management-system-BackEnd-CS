import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { TwoFaService } from '../../../src/modules/auth/twofa/twofa.service';
import { generateSecret, hotp, currentStep } from '../../../src/modules/auth/twofa/totp.util';

/**
 * Phase 9 (previously untested): the two-factor service, driven against a tiny in-memory usermaster / settings /
 * recovery-code store so the real SQL-shaped logic (replay guard, lockout, one-time reset token) is exercised.
 */
function world(init: { settings?: Record<string, string>; user?: any; recovery?: Array<{ id: number; code_hash: string; used_at: any }> } = {}) {
  const settings = new Map<string, string>(Object.entries(init.settings ?? {}));
  const user: any = { userid: 7, susername: 'asha', userlevelid: 2, enable_disable: 'E', totp_secret_enc: null, totp_enabled: false, totp_last_step: null, totp_enrolled_at: null, totp_failed_count: 0, totp_locked_until: null, totp_verified_at: null, totp_required: false, spassword: 'hash-1', ...init.user };
  const recovery = init.recovery ?? [];
  const audits: string[] = [];
  const writes: string[] = [];
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT "key", "value" FROM system_settings/.test(s)) return [...settings.entries()].filter(([k]) => k.startsWith('twofa.')).map(([key, value]) => ({ key, value }));
    if (/^SELECT "value" FROM system_settings WHERE "key" = \$1/.test(s)) return settings.has(p[0]) ? [{ value: settings.get(p[0]) }] : [];
    if (/^INSERT INTO system_settings/.test(s)) { settings.set(p[0], p[1]); writes.push(p[0]); return []; }
    if (/^INSERT INTO twofa_audit/.test(s)) { audits.push(p[2]); return []; }
    if (/FROM usermaster WHERE userid = \$1$/.test(s) && /^SELECT userid, susername/.test(s)) return p[0] === user.userid ? [{ ...user }] : [];
    if (/^SELECT spassword FROM usermaster/.test(s)) return [{ spassword: user.spassword }];
    if (/^SELECT userid, enable_disable, totp_enabled FROM usermaster WHERE susername/.test(s)) return p[0] === user.susername ? [{ ...user }] : [];
    if (/^UPDATE usermaster SET totp_last_step = \$2, totp_failed_count = 0/.test(s)) {
      if (user.totp_last_step === null || Number(user.totp_last_step) < p[1]) { user.totp_last_step = p[1]; user.totp_failed_count = 0; return [[{ userid: user.userid }], 1]; }
      return [[], 0];
    }
    if (/^UPDATE usermaster SET totp_failed_count = totp_failed_count \+ 1/.test(s)) { user.totp_failed_count += 1; return [[{ totp_failed_count: user.totp_failed_count }], 1]; }
    if (/^UPDATE usermaster SET totp_failed_count = 0, totp_locked_until = now\(\)/.test(s)) { user.totp_failed_count = 0; user.totp_locked_until = new Date(Date.now() + Number(p[1]) * 60000); return []; }
    if (/^UPDATE usermaster SET totp_failed_count = 0 WHERE userid/.test(s)) { user.totp_failed_count = 0; return []; }
    if (/^UPDATE usermaster SET totp_verified_at = now\(\)/.test(s)) { user.totp_verified_at = new Date(); return []; }
    if (/^UPDATE usermaster SET spassword = \$2/.test(s)) { user.spassword = p[1]; user.totp_failed_count = 0; user.totp_locked_until = null; return []; }
    if (/^SELECT id, code_hash FROM user_recovery_codes/.test(s)) return recovery.filter((r) => !r.used_at).map((r) => ({ id: r.id, code_hash: r.code_hash }));
    if (/^UPDATE user_recovery_codes SET used_at = now\(\) WHERE id=\$1 AND used_at IS NULL/.test(s)) { const r = recovery.find((x) => x.id === p[0] && !x.used_at); if (!r) return [[], 0]; r.used_at = new Date(); return [[{ id: r.id }], 1]; }
    return [];
  });
  const users: any = { query, findOne: jest.fn() };
  const jwt = new JwtService({});
  const config: any = { get: (k: string) => ({ JWT_SECRET: 'test-secret', TOTP_ENC_KEY: 'enc-key' } as any)[k] };
  const svc: any = new TwoFaService(users, jwt, config);
  jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc: svc as TwoFaService, any: svc, user, settings, recovery, audits, writes, query };
}
const enrolled = (w: ReturnType<typeof world>) => { const secret = generateSecret(); w.user.totp_secret_enc = w.any.encrypt(secret); w.user.totp_enabled = true; w.user.totp_enrolled_at = new Date(); return secret; };
const codeAt = (secret: string, step = currentStep()) => hotp(secret, step);

describe('twofa settings', () => {
  it('defaults, an old "roles" policy counts as optional, junk numbers fall back to the defaults', async () => {
    const d = await world().svc.getSettings();
    expect(d).toMatchObject({ policy: 'optional', graceDays: 7, rememberDays: 0, recoveryCount: 10, maxAttempts: 5, lockoutMinutes: 15, loginCode: true, forgotAuthenticator: true, approverCanApproveOwn: false });
    const w = world({ settings: { 'twofa.policy': 'roles', 'twofa.grace_days': 'abc', 'twofa.max_attempts': '9', 'twofa.required_levels': '1,,x,3' } });
    expect(await w.svc.getSettings()).toMatchObject({ policy: 'optional', graceDays: 7, maxAttempts: 9, requiredLevelIds: [1, 3] });
  });
  it('invalid values are refused with 400', async () => {
    for (const patch of [{ policy: 'roles' }, { graceDays: 1.5 }, { graceDays: -1 }, { graceDays: 366 }, { graceDays: 'x' }, { recoveryCount: 3 }, { maxAttempts: 2 }, { lockoutMinutes: 0 }, { issuer: '' }, { issuer: 'a:b' }, { issuer: 'x'.repeat(41) }, { requiredLevelIds: [40000] }]) {
      await expect(world().svc.saveSettings(patch as any, 'admin')).rejects.toBeInstanceOf(BadRequestException);
    }
  });
  it('a patch with one bad value saves nothing at all (no half-applied settings)', async () => {
    const w = world();
    await expect(w.svc.saveSettings({ policy: 'all', rememberDays: 30, graceDays: 999 } as any, 'admin')).rejects.toBeInstanceOf(BadRequestException);
    expect(w.writes).toEqual([]); expect(w.settings.size).toBe(0);
  });
  it('switching on "everyone" starts the grace period clock', async () => {
    const w = world(); await w.svc.saveSettings({ policy: 'all' }, 'admin');
    expect(w.writes).toContain('twofa.policy_since');
  });
});

describe('twofa gate (what happens at sign-in)', () => {
  it('policy off or login code off: nobody is asked', async () => {
    const a = world({ settings: { 'twofa.policy': 'off' } }); enrolled(a); expect((await a.svc.gate(7)).mode).toBe('none');
    const b = world({ settings: { 'twofa.login_code': '0' } }); enrolled(b); expect((await b.svc.gate(7)).mode).toBe('none');
  });
  it('an enrolled user is asked to verify; a remembered device skips it only inside the monthly check', async () => {
    const w = world(); enrolled(w);
    expect((await w.svc.gate(7)).mode).toBe('verify');
    w.any.isTrusted = jest.fn().mockResolvedValue(true);
    w.user.totp_verified_at = new Date(); expect((await w.svc.gate(7, 'tok')).mode).toBe('none');
    w.user.totp_verified_at = new Date(Date.now() - 31 * 86400000); expect((await w.svc.gate(7, 'tok')).mode).toBe('verify');
  });
  it('"required for everyone": inside the grace period no step, after it the user must enrol; an admin-required user enrols at once', async () => {
    const inside = world({ settings: { 'twofa.policy': 'all', 'twofa.policy_since': new Date().toISOString(), 'twofa.grace_days': '7' } });
    expect(await inside.svc.gate(7)).toMatchObject({ mode: 'none', required: true });
    expect((await inside.svc.gate(7)).graceDaysLeft).toBeGreaterThan(0);
    const over = world({ settings: { 'twofa.policy': 'all', 'twofa.policy_since': new Date(Date.now() - 9 * 86400000).toISOString(), 'twofa.grace_days': '7' } });
    expect(await over.svc.gate(7)).toMatchObject({ mode: 'enrol', graceDaysLeft: 0 });
    const flagged = world({ user: { totp_required: true } }); expect(await flagged.svc.gate(7)).toMatchObject({ mode: 'enrol', required: true });
  });
  it('an unknown user gets no step and is not required', async () => { expect(await world().svc.gate(999)).toMatchObject({ mode: 'none', required: false, enrolled: false }); });
});

describe('twofa challenge tokens', () => {
  it('round trip; the wrong mode, garbage and an access-token style token are refused', () => {
    const { svc } = world(); const t = svc.signChallenge(7, 'verify');
    expect(svc.readChallenge(t)).toBe(7); expect(svc.readChallenge(t, 'verify')).toBe(7);
    expect(() => svc.readChallenge(t, 'enrol')).toThrow(UnauthorizedException);
    expect(() => svc.readChallenge('garbage')).toThrow(UnauthorizedException);
    const access = new JwtService({}).sign({ sub: 7, purpose: '2fa', mode: 'verify' }, { secret: 'test-secret' });
    expect(() => svc.readChallenge(access)).toThrow(UnauthorizedException); // signed with the login secret, not the challenge secret
  });
});

describe('twofa verifyUserCode', () => {
  it('a correct code passes once; the same code again is a replay and is refused', async () => {
    const w = world(); const secret = enrolled(w); const c = codeAt(secret);
    expect(await w.svc.verifyUserCode(7, c, false)).toBe('totp');
    await expect(w.svc.verifyUserCode(7, c, false)).rejects.toThrow(/already used/);
    expect(w.audits).toContain('replay_rejected');
  });
  it('a code with a space in the middle ("123 456") works; an older step than the last used one is refused', async () => {
    const w = world(); const secret = enrolled(w); const now = currentStep();
    const c = codeAt(secret, now); await expect(w.svc.verifyUserCode(7, `${c.slice(0, 3)} ${c.slice(3)}`, false)).resolves.toBe('totp');
    await expect(w.svc.verifyUserCode(7, codeAt(secret, now - 1), false)).rejects.toThrow(/already used/);
  });
  it('wrong codes count up and lock the account at the maximum; while locked even the right code is refused', async () => {
    const w = world({ settings: { 'twofa.max_attempts': '3' } }); const secret = enrolled(w);
    for (let i = 0; i < 2; i++) await expect(w.svc.verifyUserCode(7, '000000', false)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(w.svc.verifyUserCode(7, '000000', false)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.user.totp_locked_until).not.toBeNull();
    await expect(w.svc.verifyUserCode(7, codeAt(secret), false)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.audits).toContain('locked_out');
  });
  it('empty code is 400, a user without 2FA is 400, text is not a valid code', async () => {
    const w = world(); enrolled(w);
    await expect(w.svc.verifyUserCode(7, '   ', false)).rejects.toBeInstanceOf(BadRequestException);
    await expect(world().svc.verifyUserCode(7, '123456', false)).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.svc.verifyUserCode(7, 'abcdef', false)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('a recovery code works once (any case, with or without the dash) and only when recovery is allowed', async () => {
    const hash = await bcrypt.hash('ABCD2345', 4);
    const w = world({ recovery: [{ id: 1, code_hash: hash, used_at: null }] }); enrolled(w);
    await expect(w.svc.verifyUserCode(7, 'abcd-2345', false)).rejects.toBeInstanceOf(UnauthorizedException); // recovery not allowed here
    expect(await w.svc.verifyUserCode(7, 'abcd-2345', true)).toBe('recovery');
    await expect(w.svc.verifyUserCode(7, 'ABCD-2345', true)).rejects.toBeInstanceOf(UnauthorizedException); // already used
  });
});

describe('twofa forgot password', () => {
  it('unknown user, disabled user, user without 2FA and a wrong code all give the same message', async () => {
    const msgs: string[] = [];
    const run = async (w: any, name: string, code: string) => { try { await w.svc.forgotVerify(name, code); msgs.push('OK'); } catch (e: any) { msgs.push(e.message); } };
    const a = world(); enrolled(a); await run(a, 'nobody', '123456');
    const b = world({ user: { enable_disable: 'D' } }); enrolled(b); await run(b, 'asha', '123456');
    const c = world(); await run(c, 'asha', '123456');
    const d = world(); enrolled(d); await run(d, 'asha', '000000');
    expect(new Set(msgs).size).toBe(1); expect(msgs[0]).toMatch(/Invalid username or code/);
  });
  it('a right code gives a reset token that changes the password exactly once, with strength rules', async () => {
    const w = world(); const secret = enrolled(w);
    const { resetToken } = await w.svc.forgotVerify('asha', codeAt(secret));
    for (const weak of ['short1A', 'alllowercase1', 'ALLUPPER1234', 'NoDigitsHere', 'x'.repeat(129) + 'A1']) await expect(w.svc.forgotReset(resetToken, weak)).rejects.toBeInstanceOf(BadRequestException);
    await w.svc.forgotReset(resetToken, 'GoodPass1');
    expect(await bcrypt.compare('GoodPass1', w.user.spassword)).toBe(true);
    await expect(w.svc.forgotReset(resetToken, 'OtherPass2')).rejects.toThrow(/already used/); // token fingerprint no longer matches
    await expect(w.svc.forgotReset('garbage', 'GoodPass1')).rejects.toThrow(/expired/);
  });
  it('switched off by policy or by the setting: forbidden', async () => {
    await expect(world({ settings: { 'twofa.policy': 'off' } }).svc.forgotVerify('asha', '123456')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(world({ settings: { 'twofa.forgot_authenticator': '0' } }).svc.forgotVerify('asha', '123456')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('twofa audit list and secrets', () => {
  it('listAudit limit is clamped to 1..300 and defaults to 100', async () => {
    for (const [input, expected] of [[undefined, 100], [0, 100], [-5, 1], [1e9, 300], ['abc', 100], [50, 50]] as any[]) {
      const w = world(); await w.svc.listAudit(input);
      expect(w.query.mock.calls.find((c: any[]) => /FROM twofa_audit a/.test(c[0]))![1]).toEqual([expected]);
    }
  });
  it('the stored secret is encrypted (not the plain text) and a tampered blob is refused', () => {
    const { any: s } = world(); const blob = s.encrypt('JBSWY3DPEHPK3PXP');
    expect(blob.startsWith('v1:')).toBe(true); expect(blob).not.toContain('JBSWY3DP'); expect(s.decrypt(blob)).toBe('JBSWY3DPEHPK3PXP');
    const bad = blob.slice(0, -4) + 'AAAA'; expect(() => s.decrypt(bad)).toThrow();
  });
});
