import { of, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import * as crypto from 'crypto';
import { MobileAuditService } from '../../../src/modules/mobile/audit/mobile-audit.service';
import { MOBILE_AUDIT_KEY, MobileAuditInterceptor } from '../../../src/modules/mobile/audit/mobile-audit.interceptor';

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

describe('MobileAuditService', () => {
  it('stores the SHA-256 of the device id (never the raw id) and trims long values', async () => {
    const ds = { query: jest.fn().mockResolvedValue([]) };
    const audit = new MobileAuditService(ds as any);
    await audit.log({ event: 'LOGIN_OK', mbno: '900000123', deviceId: 'device-abc', ip: '1.2.3.4', endpoint: '/x'.repeat(200), detail: { why: 'test' } });
    const [sql, params] = ds.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO mobile_audit_log');
    expect(params[0]).toBe('900000123');
    expect(params[1]).toBe('LOGIN_OK');
    expect(params[4]).toHaveLength(200);
    expect(params[6]).toBe(sha('device-abc'));
    expect(JSON.stringify(params)).not.toContain('device-abc');
    expect(params[11]).toBe('{"why":"test"}');
  });

  it('never throws when the database write fails', async () => {
    const ds = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(new MobileAuditService(ds as any).log({ event: 'LOGIN_FAIL' })).resolves.toBeUndefined();
  });

  it('fills client details from the request and only trusts a signed-in member for the member number', () => {
    const audit = new MobileAuditService({ query: jest.fn() } as any);
    const e = audit.fromRequest(
      { method: 'GET', originalUrl: '/api/v1/mobile/home?x=1', ip: '9.9.9.9', headers: { 'x-device-id': 'd1', 'x-request-id': 'r1', 'x-app-version': '1.0.0', 'x-platform': 'android' }, user: { kind: 'member', mbno: '5' } },
      { event: 'HOME' },
    );
    expect(e).toMatchObject({ mbno: '5', method: 'GET', endpoint: '/api/v1/mobile/home', ip: '9.9.9.9', deviceId: 'd1', requestId: 'r1', appVersion: '1.0.0', platform: 'android', event: 'HOME' });
    // a staff user object must not be mistaken for a member
    expect(audit.fromRequest({ headers: {}, user: { id: 1, username: 'admin' } }, { event: 'X' }).mbno).toBeNull();
  });
});

describe('MobileAuditInterceptor', () => {
  const ctx = (handler: object) =>
    ({
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers: {}, user: { kind: 'member', mbno: '5' } }), getResponse: () => ({ statusCode: 201 }) }),
    }) as any;

  function setup(event?: string) {
    const handler = {};
    const reflector = new Reflector();
    jest.spyOn(reflector, 'get').mockImplementation((key) => (key === MOBILE_AUDIT_KEY ? event : undefined));
    const audit = { log: jest.fn().mockResolvedValue(undefined), fromRequest: jest.fn((_r, e) => e) };
    return { handler, interceptor: new MobileAuditInterceptor(reflector, audit as any), audit };
  }

  it('does nothing for routes that are not marked', (done) => {
    const { handler, interceptor, audit } = setup(undefined);
    interceptor.intercept(ctx(handler), { handle: () => of('ok') }).subscribe({ complete: () => { expect(audit.log).not.toHaveBeenCalled(); done(); } });
  });

  it('records OK with the response status for marked routes', (done) => {
    const { handler, interceptor, audit } = setup('STATEMENT_DOWNLOAD');
    interceptor.intercept(ctx(handler), { handle: () => of('ok') }).subscribe({
      complete: () => {
        expect(audit.log).toHaveBeenCalledWith({ event: 'STATEMENT_DOWNLOAD', result: 'OK', statusCode: 201 });
        done();
      },
    });
  });

  it('records FAIL with the error status and still lets the error through', (done) => {
    const { handler, interceptor, audit } = setup('LOGIN');
    interceptor.intercept(ctx(handler), { handle: () => throwError(() => ({ status: 401 })) }).subscribe({
      error: (e) => {
        expect(e).toEqual({ status: 401 });
        expect(audit.log).toHaveBeenCalledWith({ event: 'LOGIN', result: 'FAIL', statusCode: 401 });
        done();
      },
    });
  });
});
