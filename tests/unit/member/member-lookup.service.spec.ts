// Member Lookup (GET /members/lookup): paging limits, search handling, mapping and errors.
// it.failing = KNOWN BUG (Jira): passes while the bug exists and fails the day it is fixed.
import { MemberLookupService } from '../../../src/modules/member/services-v2/member-lookup.service';

const build = (rows: any[] = []) => {
  const query = jest.fn().mockResolvedValue(rows);
  const svc = new MemberLookupService({ query } as any);
  return { svc, query };
};
const row = (o: any = {}) => ({ memberno: '610031566', membername: 'A ANAND', officeno: 1, wingno: '1', officename: 'BHILAI', ...o });

describe('MemberLookupService.lookupMembers', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('maps the database columns to the lookup shape', async () => {
    const { svc } = build([row()]);
    await expect(svc.lookupMembers()).resolves.toEqual([{ memberNo: '610031566', memberName: 'A ANAND', officeNo: 1, wingNo: '1', officeName: 'BHILAI' }]);
  });

  it('defaults to 500 rows from offset 0 and sends no search clause', async () => {
    const { svc, query } = build();
    await svc.lookupMembers();
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([500, 0]);
    expect(sql).not.toContain('ILIKE');
  });

  it.each([
    [undefined, 500], [0, 500], [-5, 500], [NaN, 500], ['abc' as any, 500], [10, 10], [10.9, 10], [1000, 1000], [5000, 1000],
  ])('limit %p becomes %p', async (limit, expected) => {
    const { svc, query } = build();
    await svc.lookupMembers(undefined, limit as any);
    expect(query.mock.calls[0][1][0]).toBe(expected);
  });

  it.each([[undefined, 0], [-1, 0], ['x' as any, 0], [0, 0], [25, 25], [25.7, 25]])('offset %p becomes %p', async (offset, expected) => {
    const { svc, query } = build();
    await svc.lookupMembers(undefined, 10, offset as any);
    expect(query.mock.calls[0][1][1]).toBe(expected);
  });

  it('puts the search text in a bound parameter, never into the SQL text (no injection)', async () => {
    const { svc, query } = build();
    await svc.lookupMembers("x'; DROP TABLE member_master; --");
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('DROP TABLE');
    expect(params[2]).toBe("%x'; DROP TABLE member\\_master; --%"); // the _ is escaped, the text is still only a parameter
    expect(sql).toContain('ILIKE $3');
  });

  it('only active members are offered', async () => {
    const { svc, query } = build();
    await svc.lookupMembers();
    expect(query.mock.calls[0][0]).toContain("m.isactive = 'Y' OR m.isactive = '1'");
  });

  it('a database failure is raised, not shown as "no members"', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(new MemberLookupService({ query } as any).lookupMembers('a')).rejects.toThrow('db down');
  });

  // ES-622
  it('% _ and \\ typed in the search box are escaped, so they are not wildcards', async () => {
    const { svc, query } = build();
    await svc.lookupMembers('%');
    expect(query.mock.calls[0][1][2]).toBe('%\\%%');
    await svc.lookupMembers('a_b');
    expect(query.mock.calls[1][1][2]).toBe('%a\\_b%');
    await svc.lookupMembers('x\\y');
    expect(query.mock.calls[2][1][2]).toBe('%x\\\\y%');
  });

  it('repeated spaces are collapsed and blank search text means no search', async () => {
    const { svc, query } = build();
    await svc.lookupMembers('  A   ANAND ');
    expect(query.mock.calls[0][1][2]).toBe('%A ANAND%');
    await svc.lookupMembers('   ');
    expect(query.mock.calls[1][1]).toEqual([500, 0]);
    expect(query.mock.calls[1][0]).not.toContain('ILIKE');
  });
});
