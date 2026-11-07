import { StreamableFile } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { Readable } from 'stream';
import { TransformInterceptor } from '../../../src/common/interceptors/transform.interceptor';
import { HttpAccessLogInterceptor } from '../../../src/common/interceptors/http-access-log.interceptor';
import { redactText } from '../../../src/common/logging/redact';
import { Roles, ROLES_KEY, UserRole } from '../../../src/common/decorators/roles.decorator';

const ctx = (res: any = { statusCode: 200 }, req: any = {}) => ({
  switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
}) as any;

describe('common/TransformInterceptor', () => {
  const t = new TransformInterceptor<any>();
  it('wraps data in the success envelope', async () => {
    const r = await lastValueFrom(t.intercept(ctx(), { handle: () => of({ a: 1 }) }));
    expect(r).toMatchObject({ success: true, statusCode: 200, data: { a: 1 } });
  });
  it('reports the real response status code (201)', async () => {
    const r = await lastValueFrom(t.intercept(ctx({ statusCode: 201 }), { handle: () => of(1) }));
    expect(r.statusCode).toBe(201);
  });
  it('wraps null data', async () => {
    const r = await lastValueFrom(t.intercept(ctx(), { handle: () => of(null) }));
    expect(r.data).toBeNull();
  });
  it('does not wrap a StreamableFile', async () => {
    const f = new StreamableFile(Buffer.from('x'));
    expect(await lastValueFrom(t.intercept(ctx(), { handle: () => of(f) }))).toBe(f);
  });
  it('does not wrap a Buffer', async () => {
    const b = Buffer.from('pdf');
    expect(await lastValueFrom(t.intercept(ctx(), { handle: () => of(b) }))).toBe(b);
  });
  it('does not wrap a Stream', async () => {
    const s = Readable.from(['x']);
    expect(await lastValueFrom(t.intercept(ctx(), { handle: () => of(s) }))).toBe(s);
  });
});

describe('common/HttpAccessLogInterceptor', () => {
  const mk = () => { const record = jest.fn().mockResolvedValue(undefined); return { record, i: new HttpAccessLogInterceptor({ record } as any) }; };
  const req = { method: 'POST', originalUrl: '/api/v1/x', route: { path: '/x' }, headers: { 'user-agent': 'UA' }, body: { a: 1 }, query: {}, ip: '1.2.3.4', user: { id: 5, username: 'bob' } };
  it('records an info row for a 200', async () => {
    const { record, i } = mk();
    await lastValueFrom(i.intercept(ctx({ statusCode: 200 }, req), { handle: () => of({ ok: 1 }) }));
    expect(record.mock.calls[0][0]).toMatchObject({ service: 'api', level: 'info', action: 'POST /x', userId: 5 });
  });
  it('records an error row when the handler throws and re-throws', async () => {
    const { record, i } = mk();
    await expect(lastValueFrom(i.intercept(ctx({ statusCode: 500 }, req), { handle: () => throwError(() => new Error('x')) }))).rejects.toThrow('x');
    expect(record.mock.calls[0][0].level).toBe('error');
  });
  it('records a warn row for a 4xx response', async () => {
    const { record, i } = mk();
    await lastValueFrom(i.intercept(ctx({ statusCode: 404 }, req), { handle: () => of(null) }));
    expect(record.mock.calls[0][0].level).toBe('warn');
  });
  it('does not store file bytes in the log', async () => {
    const { record, i } = mk();
    await lastValueFrom(i.intercept(ctx({ statusCode: 200 }, req), { handle: () => of(new StreamableFile(Buffer.from('x'))) }));
    expect(record.mock.calls[0][0].metadata.response).toBe('[file stream]');
  });
  it('stores anonymous when nobody is signed in', async () => {
    const { record, i } = mk();
    await lastValueFrom(i.intercept(ctx({ statusCode: 200 }, { ...req, user: undefined }), { handle: () => of(1) }));
    expect(record.mock.calls[0][0].metadata.user).toBe('anonymous');
  });
  it('does not write the plaintext password of a login request body to the access log', async () => {
    const { record, i } = mk();
    const login = { ...req, originalUrl: '/api/v1/auth/login', body: { username: 'bob', password: 'Plain@123' } };
    await lastValueFrom(i.intercept(ctx({ statusCode: 200 }, login), { handle: () => of({ ok: 1 }) }));
    expect(redactText(JSON.stringify(record.mock.calls[0][0]))).not.toContain('Plain@123') // record() redacts via the same patterns;
  });
  it('does not write the access token of a login response to the access log', async () => {
    const { record, i } = mk();
    await lastValueFrom(i.intercept(ctx({ statusCode: 200 }, req), { handle: () => of({ access_token: 'T0KEN-SECRET' }) }));
    expect(redactText(JSON.stringify(record.mock.calls[0][0]))).not.toContain('T0KEN-SECRET');
  });
});

describe('common/Roles decorator', () => {
  it('stores the roles under ROLES_KEY', () => {
    class C { @Roles(UserRole.ADMIN, UserRole.MANAGER) m() {} }
    expect(Reflect.getMetadata(ROLES_KEY, C.prototype.m)).toEqual(['admin', 'manager']);
  });
});
