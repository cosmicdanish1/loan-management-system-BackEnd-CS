import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { ValidateNested, IsEmail, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { buildValidationException, humanizeField } from '../../../src/common/validation/friendly-validation';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';

// ES-468 / ES-286: validation problems as plain sentences per field, with stable codes.

class MemberDto {
  @IsNotEmpty() @IsString() @MinLength(2) firstName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) rate!: number;
  @IsInt() installments!: number;
  @IsIn(['RLN', 'ALN', 'ELN']) loanType!: string;
  @IsOptional() @MaxLength(5) wing?: string;
}
class Child { @IsNotEmpty() lineOne!: string; }
class ParentDto { @Type(() => Child) @ValidateNested() @IsOptional() address?: Child; @IsString() name!: string; }

const pipe = new ValidationPipe({ exceptionFactory: buildValidationException, whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = (metatype: any): ArgumentMetadata => ({ type: 'body', metatype });
async function problems(body: any, dto: any = MemberDto) {
  try { await pipe.transform(body, meta(dto)); return null; } catch (e) { return (e as BadRequestException).getResponse() as any; }
}
const byField = (r: any, f: string) => r.errors.filter((x: any) => x.field === f);

describe('humanizeField', () => {
  it.each([
    ['firstName', 'First name'], ['rlnMaxLoanAmt', 'Rln max loan amt'], ['address.lineOne', 'Address line one'],
    ['items[2].amount', 'Items 2 amount'], ['line1', 'Line 1'],
  ])('%s -> %s', (a, b) => expect(humanizeField(a)).toBe(b));
});

describe('validation errors in plain language', () => {
  it('an empty body gives one "is required" sentence per field, not the raw class-validator list', async () => {
    const r = await problems({});
    expect(r.code).toBe('VALIDATION_FAILED');
    expect(byField(r, 'firstName')).toEqual([expect.objectContaining({ code: 'FIELD_REQUIRED', message: 'First name is required.', label: 'First name' })]);
    expect(r.message).toContain('First name is required.');
    expect(r.message.join(' ')).not.toMatch(/must be longer than or equal to|should not be empty/);
  });

  it('a value below the minimum names the limit', async () => {
    const r = await problems({ firstName: 'Ab', rate: -5, installments: 12, loanType: 'RLN' });
    expect(byField(r, 'rate')[0]).toMatchObject({ code: 'FIELD_MIN', message: 'Rate cannot be less than 0.', params: { min: 0 } });
  });

  it('a value above the maximum names the limit', async () => {
    const r = await problems({ firstName: 'Ab', rate: 150, installments: 12, loanType: 'RLN' });
    expect(byField(r, 'rate')[0]).toMatchObject({ code: 'FIELD_MAX', message: 'Rate cannot be more than 100.', params: { max: 100 } });
  });

  it('text where a number is expected, a fraction where a whole number is expected, too many decimals', async () => {
    const r = await problems({ firstName: 'Ab', rate: 'abc', installments: 2.5, loanType: 'RLN' });
    expect(byField(r, 'rate')[0]).toMatchObject({ code: 'FIELD_NUMBER', message: 'Rate must be a number.' });
    expect(byField(r, 'installments')[0]).toMatchObject({ code: 'FIELD_WHOLE_NUMBER', message: 'Installments must be a whole number.' });
    const r2 = await problems({ firstName: 'Ab', rate: 1.234, installments: 2, loanType: 'RLN' });
    expect(byField(r2, 'rate')[0]).toMatchObject({ code: 'FIELD_NUMBER' });
  });

  it('length limits and choices', async () => {
    const r = await problems({ firstName: 'A', rate: 5, installments: 1, loanType: 'XYZ', wing: 'TOOLONGWING' });
    expect(byField(r, 'firstName')[0]).toMatchObject({ code: 'FIELD_TOO_SHORT', message: 'First name must be at least 2 characters.', params: { min: 2 } });
    expect(byField(r, 'wing')[0]).toMatchObject({ code: 'FIELD_TOO_LONG', message: 'Wing can be at most 5 characters.', params: { max: 5 } });
    expect(byField(r, 'loanType')[0]).toMatchObject({ code: 'FIELD_CHOICE', message: 'Loan type must be one of: RLN, ALN, ELN.' });
  });

  it('an email in the wrong shape', async () => {
    const r = await problems({ firstName: 'Ab', email: 'nope', rate: 5, installments: 1, loanType: 'RLN' });
    expect(byField(r, 'email')[0]).toMatchObject({ code: 'FIELD_EMAIL', message: 'Email must be a valid email address.' });
  });

  it('an unknown property is refused in words', async () => {
    const r = await problems({ firstName: 'Ab', rate: 5, installments: 1, loanType: 'RLN', hack: 1 });
    expect(byField(r, 'hack')[0]).toMatchObject({ code: 'FIELD_UNKNOWN', message: 'Hack is not a field this request accepts.' });
  });

  it('nested objects get a dotted field name and a readable label', async () => {
    const r = await problems({ name: 'x', address: {} }, ParentDto);
    expect(byField(r, 'address.lineOne')[0]).toMatchObject({ code: 'FIELD_REQUIRED', label: 'Address line one', message: 'Address line one is required.' });
  });

  it('a valid body passes', async () => {
    expect(await problems({ firstName: 'Ab', rate: 5, installments: 12, loanType: 'RLN' })).toBeNull();
  });
});

describe('GlobalExceptionFilter carries codes and field problems (ES-286)', () => {
  const run = (err: any, status?: number) => {
    const json = jest.fn();
    const res: any = { status: jest.fn(() => ({ json })) };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', url: '/x', requestId: 'r-1' }) }) };
    new GlobalExceptionFilter().catch(err, host);
    return json.mock.calls[0][0];
  };
  it('validation failure: code, message list and errors array reach the response', async () => {
    const e = buildValidationException([{ property: 'name', constraints: { isNotEmpty: 'name should not be empty' } } as any]);
    const body = run(e);
    expect(body).toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED', message: ['Name is required.'], errors: [expect.objectContaining({ field: 'name', code: 'FIELD_REQUIRED' })] });
  });
  it.each([[new BadRequestException('x'), 'BAD_REQUEST'], [new (require('@nestjs/common').NotFoundException)('x'), 'NOT_FOUND'],
    [new (require('@nestjs/common').ForbiddenException)('x'), 'FORBIDDEN'], [new (require('@nestjs/common').ConflictException)('x'), 'CONFLICT'],
    [new Error('plain boom'), 'SERVER_ERROR']])('%s -> %s', (e: any, code) => expect(run(e).code).toBe(code));
  it('a code a guard already chose is kept', () => {
    const e = new (require('@nestjs/common').ForbiddenException)({ message: 'need code', code: 'AUTH_CODE_REQUIRED' });
    expect(run(e).code).toBe('AUTH_CODE_REQUIRED');
  });
});
