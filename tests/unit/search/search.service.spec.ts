import { SearchService } from '../../../src/modules/search/search.service';

const member = (o: any = {}) => ({ mbno: 5, f_name: 'Asha', m_name: null, l_name: 'Rao', basic_pay: 100, memb_date: '2020-01-01', office_name: 'HQ', isactive: 'Y', ...o });

function mk(rowsFor: (sql: string) => any[] = () => []) {
  const ds: any = { query: jest.fn(async (sql: string) => rowsFor(sql)) };
  return { svc: new SearchService(ds), ds };
}

describe('search/SearchService.globalSearch', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('type=member runs only the member query', async () => {
    const { svc, ds } = mk(() => [member()]);
    const r = await svc.globalSearch('asha', 'member');
    expect(ds.query).toHaveBeenCalledTimes(1); expect(r[0]).toMatchObject({ id: 'member-5', type: 'member', subtitle: 'Member No: 5' });
  });
  it('the member title has single spaces when there is no middle name', async () => {
    const { svc } = mk(() => [member()]);
    expect((await svc.globalSearch('asha', 'member'))[0].title).toBe('Asha Rao');
  });
  it('type=all runs member, account, transaction and loan searches', async () => {
    const { svc, ds } = mk(); await svc.globalSearch('x');
    expect(ds.query.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it('an unknown type searches nothing', async () => {
    const { svc, ds } = mk(); expect(await svc.globalSearch('x', 'bogus')).toEqual([]); expect(ds.query).not.toHaveBeenCalled();
  });
  it('the search text is passed as a bound parameter, lower-cased, never put in the SQL', async () => {
    const { svc, ds } = mk(); await svc.globalSearch("X'; DROP TABLE member_master;--", 'member');
    expect(ds.query.mock.calls[0][0]).not.toContain('DROP TABLE'); expect(ds.query.mock.calls[0][1][0]).toBe("%x'; drop table member_master;--%");
  });
  it('the limit is a bound parameter and the merged result is cut to the limit', async () => {
    const { svc, ds } = mk(() => [member({ mbno: 1 }), member({ mbno: 2 }), member({ mbno: 3 })]);
    const r = await svc.globalSearch('a', 'member', 2);
    expect(ds.query.mock.calls[0][1][1]).toBe(2); expect(r).toHaveLength(2);
  });
  it('a huge limit is capped', async () => {
    const { svc, ds } = mk(); await svc.globalSearch('a', 'member', 1e9);
    expect(ds.query.mock.calls[0][1][1]).toBeLessThanOrEqual(500);
  });
  it('a non numeric or negative limit falls back to a safe default instead of reaching the database', async () => {
    const { svc, ds } = mk(); await svc.globalSearch('a', 'member', 'abc' as any); await svc.globalSearch('a', 'member', -5);
    for (const c of ds.query.mock.calls) expect(c[1][1]).toBeGreaterThan(0);
  });
  it('the SQL wildcards % and _ typed by the user are matched literally', async () => {
    const { svc, ds } = mk(); await svc.globalSearch('%', 'member');
    expect(ds.query.mock.calls[0][1][0]).not.toBe('%%');
  });
  it('a database failure is reported to the caller, not returned as "no results"', async () => {
    const { svc, ds } = mk(); ds.query.mockRejectedValue(new Error('db down'));
    await expect(svc.globalSearch('a', 'member')).rejects.toThrow('db down');
  });
  it('an empty or missing query does not crash', async () => {
    const { svc } = mk();
    await expect(svc.globalSearch(undefined as any, 'member')).resolves.toBeDefined();
  });
});

describe('search/SearchService.getSearchSuggestions', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('a query shorter than 2 characters gives nothing and runs no query', async () => {
    const { svc, ds } = mk(); expect(await svc.getSearchSuggestions('a')).toEqual([]); expect(ds.query).not.toHaveBeenCalled();
  });
  it('trims and drops empty suggestions', async () => {
    const { svc } = mk(() => [{ suggestion: ' Asha Rao ' }, { suggestion: '   ' }, { suggestion: null }]);
    expect(await svc.getSearchSuggestions('as')).toEqual(['Asha Rao']);
  });
  it('limit and text are bound parameters', async () => {
    const { svc, ds } = mk(); await svc.getSearchSuggestions("O'Brien", 3);
    expect(ds.query.mock.calls[0][1]).toEqual(["%o'brien%", 3]);
  });
  it('a database failure is reported, not hidden', async () => {
    const { svc, ds } = mk(); ds.query.mockRejectedValue(new Error('x'));
    await expect(svc.getSearchSuggestions('ab')).rejects.toThrow('x');
  });
});
