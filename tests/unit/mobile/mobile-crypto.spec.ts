import { ConfigService } from '@nestjs/config';
import { MobileCryptoService, formatCode, newActivationCode, normalizeCode, weakMpinReason } from '../../../src/modules/mobile/access/mobile-crypto';

const config = (v: Record<string, string>) => ({ get: (k: string, d?: string) => (k in v ? v[k] : d) }) as unknown as ConfigService;
const SECRET = 'member-secret-member-secret-member-secret-5678';
const svc = () => new MobileCryptoService(config({ JWT_SECRET: 'staff-secret-staff-secret-staff-secret-1234', JWT_MEMBER_SECRET: SECRET }));

describe('activation codes', () => {
  it('are 8 characters from an alphabet without 0, O, 1, I and are random', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newActivationCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(190);
  });

  it('are typed in any case, with spaces or a dash, and shown as XXXX-XXXX', () => {
    expect(normalizeCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeCode(' abcd efgh ')).toBe('ABCDEFGH');
    expect(formatCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('are stored only as a keyed hash that depends on the server secret', () => {
    const a = svc().keyedHash('ABCDEFGH');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(svc().keyedHash('ABCDEFGH'));
    const other = new MobileCryptoService(config({ JWT_SECRET: 'x'.repeat(40), JWT_MEMBER_SECRET: 'another-member-secret-another-member-secret-1' }));
    expect(other.keyedHash('ABCDEFGH')).not.toBe(a);
    expect(svc().safeEqualHex(a, a)).toBe(true);
    expect(svc().safeEqualHex(a, svc().keyedHash('ABCDEFGJ'))).toBe(false);
  });
});

describe('App Code secret encryption', () => {
  it('round-trips and never stores the plain secret', () => {
    const s = svc();
    const enc = s.encrypt('JBSWY3DPEHPK3PXP');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(s.decrypt(enc)).toBe('JBSWY3DPEHPK3PXP');
    expect(s.encrypt('JBSWY3DPEHPK3PXP')).not.toBe(enc); // fresh IV every time
  });

  it('refuses tampered data and the wrong server secret', () => {
    const s = svc();
    const enc = s.encrypt('JBSWY3DPEHPK3PXP');
    const [iv, tag, data] = enc.split('.');
    expect(() => s.decrypt([iv, tag, Buffer.from('tampered').toString('base64url')].join('.'))).toThrow();
    const other = new MobileCryptoService(config({ JWT_SECRET: 'x'.repeat(40), JWT_MEMBER_SECRET: 'another-member-secret-another-member-secret-1' }));
    expect(() => other.decrypt(enc)).toThrow();
    expect(data.length).toBeGreaterThan(0);
  });
});

describe('weakMpinReason', () => {
  it.each(['123456', '000000', '111111', '654321', '121212', '234567', '987654'])('rejects %s', (p) => {
    expect(weakMpinReason(p)).not.toBeNull();
  });
  it.each(['12345', '1234567', 'abcdef', '12 456', ''])('rejects %p (not 6 digits)', (p) => {
    expect(weakMpinReason(p)).toBe('MPIN must be exactly 6 digits');
  });
  it('rejects anything built from the birth year or date', () => {
    expect(weakMpinReason('197304', '1973-05-14')).toMatch(/birth year/);
    expect(weakMpinReason('041973', '1973-05-14')).toMatch(/birth year/);
    expect(weakMpinReason('140573', '1973-05-14')).toMatch(/date of birth/); // DDMMYY
    expect(weakMpinReason('051473', '1973-05-14')).toMatch(/date of birth/); // MMDDYY
    expect(weakMpinReason('730514', '1973-05-14')).toMatch(/date of birth/); // YYMMDD
  });
  it('accepts a reasonable MPIN', () => {
    expect(weakMpinReason('482915', '1973-05-14')).toBeNull();
    expect(weakMpinReason('907341')).toBeNull();
  });
});
