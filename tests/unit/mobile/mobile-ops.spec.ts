import { compareVersions, csvCell } from '../../../src/modules/mobile/admin/mobile-ops.service';
import { BlocklistService } from '../../../src/modules/mobile/security/blocklist.service';

describe('mobile ops helpers (ES-241, ES-243)', () => {
  it('compares versions as numbers, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.0.9')).toBe(1);
  });
  it('CSV cells are quoted when needed and cannot run as a spreadsheet formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
  it('an IPv4 address that arrives as ::ffff:1.2.3.4 is the same address', () => {
    expect(BlocklistService.normaliseIp('::ffff:10.0.0.5')).toBe('10.0.0.5');
    expect(BlocklistService.normaliseIp(' 2001:DB8::1 ')).toBe('2001:db8::1');
  });
  it('a database failure never blocks everybody', async () => {
    const svc = new BlocklistService({ query: jest.fn().mockRejectedValue(new Error('down')) } as any, { log: jest.fn() } as any);
    expect(await svc.isBlocked('1.2.3.4', 'dev')).toBe(false);
  });
  it('the list is read once per 15 seconds and a block clears it', async () => {
    const query = jest.fn(async (sql: string) => (/SELECT kind, value/.test(sql) ? [{ kind: 'IP', value: '9.9.9.9' }] : [{ id: 1 }]));
    const svc = new BlocklistService({ query } as any, { log: jest.fn() } as any);
    expect(await svc.isBlocked('::ffff:9.9.9.9')).toBe(true); expect(await svc.isBlocked('8.8.8.8')).toBe(false); await svc.isBlocked('1.1.1.1');
    expect(query.mock.calls.filter(([s]) => /SELECT kind, value/.test(s)).length).toBe(1);
  });
});
