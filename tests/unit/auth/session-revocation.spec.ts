import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { JwtStrategy } from '../../../src/modules/auth/strategies/jwt.strategy';

// A small in-memory revoked_tokens table plus a fake JWT service, so a whole login -> refresh -> logout story can run.
function world() {
  const revoked = new Map<string, Date>();
  let n = 0;
  const tokens = new Map<string, any>(); // token string -> payload
  const um: any = { userid: 7, susername: 'bob', enableDisable: 'E', forceLogoutAt: null, userLevel: { userlevel: 'CLERK' }, email: 'b@x', permissions: [], validatePassword: async () => true, spassword: 'x', loginStatus: 'Y' };
  const repo: any = {
    findOne: jest.fn(async () => um), find: jest.fn(async () => []), save: jest.fn(async (x) => x),
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO revoked_tokens/.test(sql)) { revoked.set(params[0], params[2]); return []; }
      if (/SELECT (token_hash|1) FROM revoked_tokens/.test(sql)) return (params[0] as string[]).filter((h) => revoked.has(h)).map((h) => ({ token_hash: h }));
      return [];
    }),
  };
  const jwt: any = {
    signAsync: jest.fn(async (payload: any) => { const t = `tok${++n}`; tokens.set(t, { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }); return t; }),
    verify: jest.fn((t: string) => { if (!tokens.has(t)) throw Object.assign(new Error('invalid'), { name: 'JsonWebTokenError' }); return tokens.get(t); }),
    decode: jest.fn((t: string) => tokens.get(t) ?? null),
  };
  const config: any = { get: jest.fn((k: string, d?: any) => ({ JWT_SECRET: 's', JWT_REFRESH_SECRET: 'r' } as any)[k] ?? d) };
  const loginRepo: any = { findOne: jest.fn(async () => null), save: jest.fn(), create: jest.fn((x) => x) };
  const svc = new AuthService(repo, {} as any, loginRepo, {} as any, {} as any, {} as any, jwt, config, {} as any);
  const strategy = new JwtStrategy(repo, { get: () => 's' } as any);
  const isAccessValid = async (token: string) => {
    try { await strategy.validate({ headers: { authorization: `Bearer ${token}` } }, tokens.get(token)); return true; } catch (e) { return false; }
  };
  const login = async () => (await (svc as any).generateTokens({ id: 7, username: 'bob', email: 'b@x', role: 'clerk' })) as { accessToken: string; refreshToken: string };
  return { svc, um, revoked, tokens, login, isAccessValid, repo };
}

describe('ES-297 session revocation (login -> refresh -> logout)', () => {
  it('logout also kills the refresh token of that login (it used to keep minting new access tokens)', async () => {
    const w = world();
    const t = await w.login();
    expect(await w.isAccessValid(t.accessToken)).toBe(true);
    await w.svc.logout(7, t.accessToken);
    expect(await w.isAccessValid(t.accessToken)).toBe(false);
    await expect(w.svc.refreshToken({ refreshToken: t.refreshToken } as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a refresh token works once; the new pair works, the old refresh token does not', async () => {
    const w = world();
    const t = await w.login();
    const next = await w.svc.refreshToken({ refreshToken: t.refreshToken } as any);
    expect(next.accessToken).toBeTruthy();
    await expect(w.svc.refreshToken({ refreshToken: t.refreshToken } as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('using an already-used refresh token ends the whole session (the stolen copy and the real one)', async () => {
    const w = world();
    const t = await w.login();
    const next: any = await w.svc.refreshToken({ refreshToken: t.refreshToken } as any); // the real app rotates
    await w.svc.refreshToken({ refreshToken: t.refreshToken } as any).catch(() => undefined); // an attacker replays the old one
    expect(await w.isAccessValid(next.accessToken)).toBe(false);
    await expect(w.svc.refreshToken({ refreshToken: next.refreshToken } as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refreshing keeps the same session id, so a later logout still covers the newest tokens', async () => {
    const w = world();
    const t = await w.login();
    const next: any = await w.svc.refreshToken({ refreshToken: t.refreshToken } as any);
    expect(w.tokens.get(next.accessToken).sid).toBe(w.tokens.get(t.accessToken).sid);
    await w.svc.logout(7, next.accessToken);
    await expect(w.svc.refreshToken({ refreshToken: next.refreshToken } as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logging out one PC leaves the same user\'s other PC working', async () => {
    const w = world();
    const pc1 = await w.login(); const pc2 = await w.login();
    await w.svc.logout(7, pc1.accessToken);
    expect(await w.isAccessValid(pc2.accessToken)).toBe(true);
    await expect(w.svc.refreshToken({ refreshToken: pc2.refreshToken } as any)).resolves.toBeDefined();
  });

  it('two refreshes in a row each work once with the token they were given', async () => {
    const w = world();
    let t: any = await w.login();
    for (let i = 0; i < 3; i++) t = await w.svc.refreshToken({ refreshToken: t.refreshToken } as any);
    expect(t.refreshToken).toBeTruthy();
  });

  it('a garbage refresh token is still a 401', async () => {
    await expect(world().svc.refreshToken({ refreshToken: 'nope' } as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ES-297 change password ends the other sessions', () => {
  it('tokens issued before the change stop working, the new pair returned with the change works', async () => {
    const w = world();
    const old = await w.login();
    w.tokens.get(old.accessToken).iat -= 5; w.tokens.get(old.refreshToken).iat -= 5; // issued a few seconds earlier
    const r: any = await w.svc.changePassword('bob', 'old', 'NewPass@1');
    expect(w.um.forceLogoutAt).toBeInstanceOf(Date);
    expect(await w.isAccessValid(old.accessToken)).toBe(false);
    await expect(w.svc.refreshToken({ refreshToken: old.refreshToken } as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(r.message).toBe('Password changed successfully');
    expect(await w.isAccessValid(r.accessToken)).toBe(true);
    await expect(w.svc.refreshToken({ refreshToken: r.refreshToken } as any)).resolves.toBeDefined();
  });
});

describe('revoked_tokens hashing', () => {
  it('the session marker is a SHA-256 of "sid:<id>" (so it can never collide with a real token hash)', async () => {
    const w = world();
    const t = await w.login();
    await w.svc.logout(7, t.accessToken);
    const sid = w.tokens.get(t.accessToken).sid;
    expect(w.revoked.has(crypto.createHash('sha256').update(`sid:${sid}`).digest('hex'))).toBe(true);
  });
});
