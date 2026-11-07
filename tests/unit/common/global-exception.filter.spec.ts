import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';
import { AlertBridge } from '../../../src/modules/alerts/alert-bridge';

function run(exception: unknown, req: any = {}) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'GET', url: '/x', originalUrl: '/x', headers: {}, ...req }),
    }),
  };
  new GlobalExceptionFilter().catch(exception, host);
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}
const qfe = (msg: string) => new QueryFailedError('SELECT 1', [], new Error(msg));

describe('common/GlobalExceptionFilter', () => {
  beforeEach(() => jest.spyOn(AlertBridge, 'get').mockReturnValue(null as any));
  afterEach(() => jest.restoreAllMocks());

  it('keeps the status and message of an HttpException', () => {
    const r = run(new NotFoundException('gone'));
    expect(r.status).toBe(404); expect(r.body.message).toBe('gone');
  });
  it('maps a plain Error to 500', () => {
    const r = run(new Error('boom'));
    expect(r.status).toBe(500); expect(r.body.message).toBe('boom');
  });
  it('maps a duplicate-key SQL failure to 409', () => {
    const r = run(qfe('duplicate key value violates unique constraint'));
    expect(r.status).toBe(409); expect(r.body.message).toBe('Record already exists');
  });
  it('maps a foreign-key SQL failure to 400', () => {
    const r = run(qfe('violates foreign key constraint'));
    expect(r.status).toBe(400); expect(r.body.message).toBe('Referenced record not found');
  });
  it('maps another SQL failure to 400 "Database Error"', () => {
    const r = run(qfe('column x does not exist'));
    expect(r.status).toBe(400); expect(r.body.error).toBe('Database Error');
  });
  it('does not leak the SQL text of a database error to the caller', () => {
    const r = run(qfe('column "secret_col" of relation "ledger" does not exist'));
    expect(JSON.stringify(r.body)).not.toContain('secret_col');
  });
  it('passes body-parser 4xx status through (413)', () => {
    const e: any = new Error('too large'); e.status = 413;
    expect(run(e).status).toBe(413);
  });
  it('returns the machine-readable code of guard exceptions', () => {
    const r = run(new ForbiddenException({ statusCode: 403, code: 'MENU_RIGHT_REQUIRED', message: 'no' }));
    expect(r.body.code).toBe('MENU_RIGHT_REQUIRED');
  });
  it('returns mobile extras (attemptsLeft, retryAfterSeconds) when a code is present', () => {
    const r = run(new HttpException({ code: 'BAD_MPIN', message: 'x', attemptsLeft: 2, retryAfterSeconds: 30 }, 401));
    expect(r.body.attemptsLeft).toBe(2); expect(r.body.retryAfterSeconds).toBe(30);
  });
  it('keeps a validation message array as an array', () => {
    const r = run(new BadRequestException(['a must be a string', 'b is required']));
    expect(Array.isArray(r.body.message)).toBe(true);
  });
  it('answers with statusCode, path, method and timestamp', () => {
    const r = run(new NotFoundException('x'), { url: '/members/5', method: 'POST' });
    expect(r.body).toMatchObject({ statusCode: 404, path: '/members/5', method: 'POST' });
    expect(new Date(r.body.timestamp).getTime()).not.toBeNaN();
  });
  it('alerts Telegram about a failed staff login but not a mobile login', () => {
    const loginFailed = jest.fn(); const reportServerError = jest.fn();
    jest.spyOn(AlertBridge, 'get').mockReturnValue({ loginFailed, reportServerError } as any);
    run(new HttpException('no', 401), { method: 'POST', url: '/api/v1/auth/login', originalUrl: '/api/v1/auth/login', body: { username: 'u' }, headers: {}, socket: {} });
    expect(loginFailed).toHaveBeenCalledTimes(1);
    run(new HttpException('no', 401), { method: 'POST', url: '/api/v1/mobile/auth/login', originalUrl: '/api/v1/mobile/auth/login', body: {}, headers: {}, socket: {} });
    expect(loginFailed).toHaveBeenCalledTimes(1);
  });
  it('alerts about a 500 but not about a 404', () => {
    const reportServerError = jest.fn();
    jest.spyOn(AlertBridge, 'get').mockReturnValue({ loginFailed: jest.fn(), reportServerError } as any);
    run(new NotFoundException('x'));
    expect(reportServerError).not.toHaveBeenCalled();
    run(new Error('db down'));
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });
  it('masks key values of SQL errors sent to Telegram', () => {
    const reportServerError = jest.fn();
    jest.spyOn(AlertBridge, 'get').mockReturnValue({ loginFailed: jest.fn(), reportServerError } as any);
    run(qfe('invalid input Key (mbno)=(12345) is bad'));
    expect(reportServerError.mock.calls[0][0].message).not.toContain('12345');
  });
  it('never throws when the alert bridge itself fails', () => {
    jest.spyOn(AlertBridge, 'get').mockImplementation(() => { throw new Error('x'); });
    expect(() => run(new Error('boom'))).not.toThrow();
  });
});
