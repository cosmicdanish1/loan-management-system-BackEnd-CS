import { redactText } from '../../../src/common/logging/redact';
import { safeStringify } from '../../../src/common/logging/safe-stringify';

describe('common/redactText', () => {
  it('masks a quoted JSON password', () => {
    expect(redactText('{"password":"Secret@1"}')).not.toContain('Secret@1');
  });
  it('masks a quoted JSON token', () => {
    expect(redactText('{"token":"abc.def.ghi"}')).toContain('[REDACTED]');
  });
  it('masks a Bearer header', () => {
    const out = redactText('Authorization: Bearer eyJhbGciOi.abc-def_1~2+3/4==');
    expect(out).toBe('Authorization: Bearer [REDACTED]');
  });
  it('masks an Aadhaar number with spaces', () => {
    expect(redactText('{"aadhaar":"1234 5678 9012"}')).not.toContain('5678');
  });
  it('masks a PAN number', () => {
    expect(redactText('{"pan":"ABCDE1234F"}')).not.toContain('ABCDE1234F');
  });
  it('leaves harmless text untouched', () => {
    expect(redactText('loan 123 saved')).toBe('loan 123 saved');
  });
  it('masks every occurrence, not only the first', () => {
    const out = redactText('{"password":"a1"} {"password":"b2"}');
    expect(out).not.toContain('a1');
    expect(out).not.toContain('b2');
  });
  it('masks a password written as key=value without quotes (form/query string)', () => {
    expect(redactText('username=bob&password=Secret123')).not.toContain('Secret123');
  });
  it('masks a single-quoted password', () => {
    expect(redactText("{'password':'Secret123'}")).not.toContain('Secret123');
  });
  it('masks a refresh token / secret field', () => {
    const out = redactText('{"refreshToken":"R-123456","secret":"S-987"}');
    expect(out).not.toContain('R-123456');
    expect(out).not.toContain('S-987');
  });
});

describe('common/safeStringify', () => {
  it('serialises plain objects', () => expect(safeStringify({ a: 1 })).toBe('{"a":1}'));
  it('serialises BigInt as string', () => expect(safeStringify({ n: BigInt(10) })).toBe('{"n":"10"}'));
  it('does not throw on circular references', () => {
    const a: any = {}; a.self = a;
    expect(() => safeStringify(a)).not.toThrow();
  });
  it('handles undefined', () => expect(safeStringify(undefined)).toBeUndefined());
  it('handles an object whose String() throws', () => {
    const a: any = {}; a.self = a; a.toString = () => { throw new Error('x'); };
    expect(safeStringify(a)).toBe('"[unserializable]"');
  });
});
