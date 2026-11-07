import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from '../../../src/modules/auth/strategies/jwt.strategy';
import { MemberJwtStrategy } from '../../../src/modules/mobile/auth/member-jwt.strategy';
import { MemberTokenService } from '../../../src/modules/mobile/auth/member-token.service';
import { resolveMemberSecret } from '../../../src/modules/mobile/auth/member-secret';

const STAFF_SECRET = 'staff-secret-staff-secret-staff-secret-1234';
const MEMBER_SECRET = 'member-secret-member-secret-member-secret-5678';

const config = (values: Record<string, string>) =>
  ({ get: (k: string, d?: string) => (k in values ? values[k] : d) }) as unknown as ConfigService;

function memberStrategy(rows: unknown[]) {
  const ds = { query: jest.fn().mockResolvedValue(rows) };
  return { strategy: new MemberJwtStrategy(config({ JWT_SECRET: STAFF_SECRET, JWT_MEMBER_SECRET: MEMBER_SECRET }), ds as any), ds };
}

describe('member token validation (MemberJwtStrategy)', () => {
  const good = { typ: 'member', aud: 'mobile', mbno: '900000123', did: 7 };

  it('accepts a member token for an ACTIVE account on a trusted phone', async () => {
    const { strategy, ds } = memberStrategy([{ status: 'ACTIVE', revoked: false }]);
    await expect(strategy.validate(good as any)).resolves.toEqual({ kind: 'member', mbno: '900000123', deviceId: 7 });
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('mobile_account'), ['900000123', 7]);
  });

  it.each([
    ['a staff-shaped token', { sub: 1, username: 'admin', role: 'admin' }],
    ['a token with the wrong type', { ...good, typ: 'staff' }],
    ['a token with the wrong audience', { ...good, aud: 'web' }],
    ['a token without a device', { ...good, did: undefined }],
    ['a token without a member', { ...good, mbno: undefined }],
  ])('rejects %s without touching the database', async (_n, payload) => {
    const { strategy, ds } = memberStrategy([{ status: 'ACTIVE', revoked: false }]);
    await expect(strategy.validate(payload as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ds.query).not.toHaveBeenCalled();
  });

  it.each([
    ['no account row', []],
    ['a LOCKED account', [{ status: 'LOCKED', revoked: false }]],
    ['a BLOCKED account', [{ status: 'BLOCKED', revoked: false }]],
    ['a DEACTIVATED account', [{ status: 'DEACTIVATED', revoked: false }]],
    ['a revoked phone', [{ status: 'ACTIVE', revoked: true }]],
  ])('rejects a valid-looking token when there is %s', async (_n, rows) => {
    const { strategy } = memberStrategy(rows as unknown[]);
    await expect(strategy.validate(good as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('staff strategy refuses member tokens (JwtStrategy)', () => {
  it('rejects typ=member and aud=mobile before any database lookup', async () => {
    const repo = { query: jest.fn(), findOne: jest.fn() };
    const strategy = new JwtStrategy(repo as any, config({ JWT_SECRET: STAFF_SECRET }));
    const req = { headers: {} };
    await expect(strategy.validate(req, { sub: 5, typ: 'member' } as any)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(strategy.validate(req, { sub: 5, aud: 'mobile' } as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.query).not.toHaveBeenCalled();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

describe('secrets are separate', () => {
  it('a member token signed with the member secret does not verify with the staff secret, and the reverse', async () => {
    const memberJwt = new JwtService({ secret: MEMBER_SECRET, signOptions: { expiresIn: '15m' } });
    const staffJwt = new JwtService({ secret: STAFF_SECRET });
    const memberToken = await new MemberTokenService(memberJwt).signAccess('900000123', 7);

    await expect(staffJwt.verifyAsync(memberToken)).rejects.toBeDefined();
    const decoded = await memberJwt.verifyAsync(memberToken);
    expect(decoded).toMatchObject({ typ: 'member', aud: 'mobile', mbno: '900000123', did: 7 });

    const staffToken = await staffJwt.signAsync({ sub: 1, username: 'admin' });
    await expect(memberJwt.verifyAsync(staffToken)).rejects.toBeDefined();
  });

  it('uses JWT_MEMBER_SECRET when it is strong and different from JWT_SECRET', () => {
    expect(resolveMemberSecret(config({ JWT_SECRET: STAFF_SECRET, JWT_MEMBER_SECRET: MEMBER_SECRET }))).toBe(MEMBER_SECRET);
  });

  it.each([
    ['missing', { JWT_SECRET: STAFF_SECRET }],
    ['too short', { JWT_SECRET: STAFF_SECRET, JWT_MEMBER_SECRET: 'short' }],
    ['equal to the staff secret', { JWT_SECRET: STAFF_SECRET, JWT_MEMBER_SECRET: STAFF_SECRET }],
  ])('falls back to a temporary random secret when JWT_MEMBER_SECRET is %s (server still boots)', (_n, values) => {
    const s = resolveMemberSecret(config(values as Record<string, string>));
    expect(s).toHaveLength(96);
    expect(s).not.toBe(STAFF_SECRET);
  });
});
