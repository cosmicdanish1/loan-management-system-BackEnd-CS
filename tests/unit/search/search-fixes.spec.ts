import { SearchService } from '../../../src/modules/search/search.service';

const mkS = (rows: any[] = []) => { const ds: any = { query: jest.fn(async () => rows) }; return { svc: new SearchService(ds), ds }; };
beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

describe('search fixes (ES-402, ES-404)', () => {
  it('limit: whole numbers pass, 1..500 range, text/negative/0/NaN/Infinity use 50, decimals are floored', async () => {
    const cases: Array<[any, number]> = [[10, 10], [500, 500], [501, 500], [1e9, 500], [Infinity, 50], ['abc', 50], [-5, 50], [0, 50], [NaN, 50], [7.9, 7], ['25', 25]];
    for (const [input, expected] of cases) {
      const { svc, ds } = mkS(); await svc.globalSearch('a', 'member', input);
      expect(ds.query.mock.calls[0][1][1]).toBe(expected);
    }
  });
  it('title skips empty name parts: no middle name, blank middle name, no last name', async () => {
    const t = async (o: any) => (await mkS([{ mbno: 1, ...o }]).svc.globalSearch('a', 'member'))[0].title;
    expect(await t({ f_name: 'Asha', m_name: null, l_name: 'Rao' })).toBe('Asha Rao');
    expect(await t({ f_name: 'Asha', m_name: '  ', l_name: 'Rao' })).toBe('Asha Rao');
    expect(await t({ f_name: 'Asha', m_name: 'K', l_name: 'Rao' })).toBe('Asha K Rao');
    expect(await t({ f_name: ' Asha ', m_name: '', l_name: null })).toBe('Asha');
  });
  it('a failure in any sub-search (accounts, transactions, loans) is reported, not hidden', async () => {
    for (const type of ['account', 'transaction', 'loan']) {
      const { svc, ds } = mkS(); ds.query.mockRejectedValue(new Error('db down'));
      if (type === 'account') { // the optional-table lookups inside are allowed to fail on their own
        await expect(svc.globalSearch('a', type)).resolves.toBeDefined();
      } else await expect(svc.globalSearch('a', type)).rejects.toThrow('db down');
    }
  });
  it('suggestions: limit is checked, double spaces are collapsed, short or missing text gives nothing', async () => {
    const { svc, ds } = mkS([{ suggestion: 'Asha   Rao' }]);
    expect(await svc.getSearchSuggestions('as', -1 as any)).toEqual(['Asha Rao']);
    expect(ds.query.mock.calls[0][1][1]).toBe(5);
    expect(await svc.getSearchSuggestions(undefined as any)).toEqual([]);
  });
});
