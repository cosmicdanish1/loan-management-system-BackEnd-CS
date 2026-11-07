import { HttpException, UnauthorizedException } from '@nestjs/common';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';

function run(exception: unknown) {
  const json = jest.fn();
  const res: any = { status: jest.fn().mockReturnValue({ json }) };
  const req: any = { method: 'POST', url: '/api/v1/mobile/auth/login', originalUrl: '/api/v1/mobile/auth/login', headers: {}, body: {} };
  const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
  new GlobalExceptionFilter().catch(exception, host);
  return { status: res.status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe('GlobalExceptionFilter keeps the machine-readable fields the member app needs', () => {
  it('passes code, attemptsLeft, retryAfterSeconds and action through', () => {
    const wrong = run(new UnauthorizedException({ statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'no', attemptsLeft: 3 }));
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: 'INVALID_CREDENTIALS', attemptsLeft: 3 });

    const delay = run(new HttpException({ statusCode: 429, code: 'MPIN_DELAY', message: 'wait', retryAfterSeconds: 30 }, 429));
    expect(delay.body).toMatchObject({ code: 'MPIN_DELAY', retryAfterSeconds: 30 });

    const approval = run(new HttpException({ statusCode: 403, code: 'APPCODE_REQUIRED', message: 'code', action: 'LARGE_STATEMENT' }, 403));
    expect(approval.body).toMatchObject({ code: 'APPCODE_REQUIRED', action: 'LARGE_STATEMENT' });
  });

  it('adds only the plain status code for ordinary errors (ES-286), none of the member-app fields', () => {
    const r = run(new UnauthorizedException('Please sign in'));
    expect(r.body.code).toBe('UNAUTHORIZED');
    expect(r.body.attemptsLeft).toBeUndefined();
    expect(r.body.retryAfterSeconds).toBeUndefined();
    expect(r.body.action).toBeUndefined();
  });
});
