import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PasswordUtil } from '../../../src/modules/auth/utils/password.util';
import { mapUserMasterToUser, roleFromLegacyLevel } from '../../../src/modules/auth/utils/map-user-master-to-user';
import { base32Decode, base32Encode, currentStep, generateSecret, hotp, otpauthUrl, verifyTotp } from '../../../src/modules/auth/twofa/totp.util';
import { JwtStrategy } from '../../../src/modules/auth/strategies/jwt.strategy';

describe('auth/PasswordUtil', () => {
  it('hash then compare succeeds', async () => {
    const h = await PasswordUtil.hashPassword('Abc@12345');
    expect(await PasswordUtil.comparePassword('Abc@12345', h)).toBe(true);
  });
  it('a wrong password does not match', async () => {
    const h = await PasswordUtil.hashPassword('Abc@12345');
    expect(await PasswordUtil.comparePassword('abc@12345', h)).toBe(false);
  });
  it('hashes are salted (same input, different hash)', async () => {
    expect(await PasswordUtil.hashPassword('x1')).not.toBe(await PasswordUtil.hashPassword('x1'));
  });
  it('generateRandomPassword honours the length', () => {
    expect(PasswordUtil.generateRandomPassword(20)).toHaveLength(20);
    expect(PasswordUtil.generateRandomPassword()).toHaveLength(12);
  });
  it('generated passwords differ', () => {
    expect(PasswordUtil.generateRandomPassword()).not.toBe(PasswordUtil.generateRandomPassword());
  });
  it('strength: strong password is valid with score 5', () => {
    expect(PasswordUtil.validatePasswordStrength('Abcdef1!')).toMatchObject({ isValid: true, score: 5 });
  });
  it('strength: short lowercase password is invalid with feedback', () => {
    const r = PasswordUtil.validatePasswordStrength('abc');
    expect(r.isValid).toBe(false); expect(r.feedback.length).toBeGreaterThan(0);
  });
  it('strength: empty string is invalid', () => {
    expect(PasswordUtil.validatePasswordStrength('').isValid).toBe(false);
  });
});

describe('auth/roleFromLegacyLevel + mapUserMasterToUser', () => {
  it('maps ADMINISTRATOR to administrator', () => expect(roleFromLegacyLevel('ADMINISTRATOR')).toBe('administrator'));
  it('maps BRANCH MANAGER to branch_manager', () => expect(roleFromLegacyLevel('BRANCH MANAGER')).toBe('branch_manager'));
  it('unknown level is lower-cased with underscores', () => expect(roleFromLegacyLevel('Head Cashier')).toBe('head_cashier'));
  it('empty level falls back to data_operator', () => expect(roleFromLegacyLevel('')).toBe('data_operator'));

  const um = (o: any = {}) => ({
    userid: 5, susername: 'bob', email: null, firstName: null, lastName: null, avatar: null,
    userLevel: { userlevel: 'CLERK' }, hasExplicitPermissions: false, permissions: [], isEnabled: true, canPassTransactions: false, ...o,
  }) as any;
  it('fills default email / names from the username', () => {
    const u = mapUserMasterToUser(um());
    expect(u).toMatchObject({ id: 5, username: 'bob', email: 'bob@example.com', firstName: 'bob', lastName: '' });
  });
  it('legacy row without explicit permissions: clerk gets only read_member', () => {
    expect(mapUserMasterToUser(um()).permissions).toEqual(['read_member']);
  });
  it('legacy administrator gets MANAGE_SYSTEM_CONFIG, DAY_END and BACKUP', () => {
    const p = mapUserMasterToUser(um({ userLevel: { userlevel: 'ADMINISTRATOR' } })).permissions;
    expect(p).toEqual(expect.arrayContaining(['manage_users', 'manage_system_config', 'day_end_operations', 'perform_backup']));
  });
  it('explicit empty permissions mean zero rights (not the defaults)', () => {
    expect(mapUserMasterToUser(um({ hasExplicitPermissions: true, permissions: [] })).permissions).toEqual([]);
  });
  it('explicit permissions are copied as is', () => {
    expect(mapUserMasterToUser(um({ hasExplicitPermissions: true, permissions: ['read_loan'] })).permissions).toEqual(['read_loan']);
  });
  it('carries isActive and canPassTransactions', () => {
    const u = mapUserMasterToUser(um({ isEnabled: false, canPassTransactions: true }));
    expect(u.isActive).toBe(false); expect(u.canPassTransactions).toBe(true);
  });
});

describe('auth/TOTP (RFC 6238 / RFC 4226)', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it('base32 round trip', () => {
    const b = crypto.randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('base32Decode rejects invalid characters', () => {
    expect(() => base32Decode('ABC1')).toThrow();
  });
  it('base32 encode of RFC key is the well-known value', () => {
    expect(rfcSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
  it('HOTP matches the RFC 4226 test vectors', () => {
    const exp = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    exp.forEach((e, i) => expect(hotp(rfcSecret, i)).toBe(e));
  });
  it('generateSecret is 32 base32 chars (160 bit) and random', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(generateSecret());
  });
  it('verifyTotp accepts the current code and returns its step', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(rfcSecret, hotp(rfcSecret, currentStep(now)), 1, now)).toBe(currentStep(now));
  });
  it('accepts a code from the previous and the next step (clock drift)', () => {
    const now = 1_700_000_000_000; const s = currentStep(now);
    expect(verifyTotp(rfcSecret, hotp(rfcSecret, s - 1), 1, now)).toBe(s - 1);
    expect(verifyTotp(rfcSecret, hotp(rfcSecret, s + 1), 1, now)).toBe(s + 1);
  });
  it('rejects a code two steps old', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(rfcSecret, hotp(rfcSecret, currentStep(now) - 2), 1, now)).toBeNull();
  });
  it('rejects non numeric, short and empty codes', () => {
    for (const c of ['abcdef', '12345', '', '1234567', null as any, undefined as any]) {
      expect(verifyTotp(rfcSecret, c)).toBeNull();
    }
  });
  it('accepts a code typed with a space (123 456)', () => {
    const now = 1_700_000_000_000; const c = hotp(rfcSecret, currentStep(now));
    expect(verifyTotp(rfcSecret, `${c.slice(0, 3)} ${c.slice(3)}`, 1, now)).not.toBeNull();
  });
  it('otpauthUrl carries secret, issuer, digits and period', () => {
    const u = otpauthUrl('SECRET', 'bob@x', 'Fibe App');
    expect(u).toContain('otpauth://totp/Fibe%20App:bob%40x?secret=SECRET');
    expect(u).toContain('digits=6'); expect(u).toContain('period=30');
  });
});

describe('auth/JwtStrategy.validate', () => {
  const repo = (o: any = {}) => ({ query: jest.fn().mockResolvedValue([]), findOne: jest.fn(), ...o }) as any;
  const mk = (r: any) => new JwtStrategy(r, { get: () => 'secret-for-tests' } as any);
  const req = (t = 'tok') => ({ headers: { authorization: `Bearer ${t}` } });
  const enabled = { userid: 1, susername: 'bob', userLevel: { userlevel: 'CLERK' }, enableDisable: 'E', forceLogoutAt: null, hasExplicitPermissions: false, permissions: [], isEnabled: true, canPassTransactions: false };

  it('rejects a member (mobile) token', async () => {
    await expect(mk(repo()).validate(req(), { sub: 1, typ: 'member' } as any)).rejects.toThrow(/Member tokens/);
    await expect(mk(repo()).validate(req(), { sub: 1, aud: 'mobile' } as any)).rejects.toThrow(/Member tokens/);
  });
  it('rejects a revoked token', async () => {
    const r = repo({ query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) });
    await expect(mk(r).validate(req(), { sub: 1 } as any)).rejects.toThrow('Token has been revoked');
  });
  it('looks the token up by SHA-256 hash, never the raw token', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue(enabled) });
    await mk(r).validate(req('abc'), { sub: 1 } as any);
    expect(r.query.mock.calls[0][1][0]).toEqual([crypto.createHash('sha256').update('abc').digest('hex')]);
  });
  it('rejects an unknown user', async () => {
    await expect(mk(repo({ findOne: jest.fn().mockResolvedValue(null) })).validate(req(), { sub: 1 } as any)).rejects.toThrow(UnauthorizedException);
  });
  it('rejects a disabled user', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ ...enabled, enableDisable: 'D' }) });
    await expect(mk(r).validate(req(), { sub: 1 } as any)).rejects.toThrow(/disabled/);
  });
  it('rejects a token issued before the force-logout time', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ ...enabled, forceLogoutAt: new Date(2_000_000_000_000) }) });
    await expect(mk(r).validate(req(), { sub: 1, iat: 1_000_000_000 } as any)).rejects.toThrow(/terminated/);
  });
  it('accepts a token issued after the force-logout time', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ ...enabled, forceLogoutAt: new Date(1_000_000_000_000) }) });
    expect((await mk(r).validate(req(), { sub: 1, iat: 2_000_000_000 } as any)).username).toBe('bob');
  });
  it('returns the mapped user for a valid token', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue(enabled) });
    expect(await mk(r).validate(req(), { sub: 1 } as any)).toMatchObject({ id: 1, role: 'clerk' });
  });
  it('creates the revoked_tokens table at boot', async () => {
    const r = repo();
    await mk(r).onModuleInit();
    expect(r.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS revoked_tokens');
  });
});
