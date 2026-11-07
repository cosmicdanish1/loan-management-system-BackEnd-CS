// ES-331 check: runs the real GlobalExceptionFilter with a spy logger. Run:  npx ts-node -T tests/qa/21-filter-check.ts
import { BadRequestException, NotFoundException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';

const results: { id: string; title: string; ok: boolean; detail: string }[] = [];
function run(exception: any) {
  const calls: { level: string; msg: string; trace?: any }[] = [];
  const filter: any = new GlobalExceptionFilter();
  filter.logger = { warn: (m: string) => calls.push({ level: 'warn', msg: m }), error: (m: string, t?: any) => calls.push({ level: 'error', msg: m, trace: t }), log: () => { } };
  let status = 0; let body: any;
  const host: any = { switchToHttp: () => ({ getResponse: () => ({ status: (s: number) => { status = s; return { json: (b: any) => { body = b; } }; } }), getRequest: () => ({ method: 'POST', url: '/api/v1/x', originalUrl: '/api/v1/x', body: {} }) }) };
  filter.catch(exception, host);
  return { calls, status, body };
}
function check(id: string, title: string, ok: boolean, detail = '') { results.push({ id, title, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}${ok ? '' : '  -> ' + detail}`); }

let r = run(new BadRequestException('Another day-end process is currently in progress'));
check('LF-331-1', 'A refused request (400) is logged once at WARN, with no stack trace', r.calls.length === 1 && r.calls[0].level === 'warn' && r.calls[0].trace === undefined, JSON.stringify(r.calls));
check('LF-331-2', 'The response to the client is unchanged (400 and the same message)', r.status === 400 && r.body.message === 'Another day-end process is currently in progress', JSON.stringify(r.body));
r = run(new NotFoundException('Voucher not found'));
check('LF-331-3', '404 is WARN', r.calls[0].level === 'warn' && r.status === 404);
r = run(new ConflictException('Username already exists'));
check('LF-331-4', '409 is WARN', r.calls[0].level === 'warn' && r.status === 409);
r = run(new BadRequestException(['field a must be a string', 'field b is required']));
check('LF-331-5', 'Validation errors with a list of messages are logged on one line', r.calls[0].level === 'warn' && /field a must be a string; field b is required/.test(r.calls[0].msg), r.calls[0].msg);
r = run(new InternalServerErrorException('boom'));
check('LF-331-6', 'A real server error (500) is still logged at ERROR with the stack', r.calls[0].level === 'error' && !!r.calls[0].trace && r.status === 500, JSON.stringify(r.calls[0]));
r = run(new Error('Something broke'));
check('LF-331-7', 'An unhandled Error (500) is still ERROR with the stack', r.calls[0].level === 'error' && !!r.calls[0].trace && r.status === 500, JSON.stringify(r.calls[0]));
const qf: any = Object.create(QueryFailedError.prototype); qf.message = 'column "x" does not exist'; qf.stack = 'stack...';
r = run(qf);
check('LF-331-8', 'A failed SQL statement (mapped to 400 for the caller) is still logged at ERROR with the stack', r.status === 400 && r.calls[0].level === 'error' && !!r.calls[0].trace, JSON.stringify(r.calls[0]));
const failed = results.filter(x => !x.ok).length;
console.log(`\n21-filter-check: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
