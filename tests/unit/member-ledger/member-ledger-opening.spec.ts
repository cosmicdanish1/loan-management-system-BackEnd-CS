import { MemberLedgerService } from '../../../src/modules/member-ledger/member-ledger.service';

/**
 * ES-576: the balance a member carried into the ledger (fundsmaster opening) must be part of the Member Detail Ledger's
 * RD/CD, share and FRS openings, running balances and closing, as in the legacy report. Numbers are member 610021030
 * (legacy report: opening 3,25,715 CR, first row 1,500 -> 3,27,215 CR).
 */
describe('MemberLedgerService carries the fundsmaster opening (ES-576)', () => {
  const funds = (over: Record<string, number> = {}) => [{ cd: 325715, share: 0, md: 0, md1: 0, ...over }];
  const sqlRouter = (o: { ledgerRows?: any[]; opening?: any[]; funds?: any[] } = {}) => jest.fn(async (sql: string) => {
    if (/FROM fundsmaster/.test(sql)) return 'funds' in o ? o.funds : funds();
    if (/GROUP BY code/.test(sql)) return o.opening ?? [];
    if (/date_key/.test(sql)) return o.ledgerRows ?? [];
    return [{ ltl: '0', emer: '0' }]; // loan opening
  });
  const build = (dataSource: any, rawEntries: any[] = []) => {
    const qb: any = {};
    for (const m of ['leftJoinAndMapOne', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'select']) qb[m] = jest.fn().mockReturnValue(qb);
    qb.getRawMany = jest.fn().mockResolvedValue(rawEntries);
    return new MemberLedgerService(
      { createQueryBuilder: () => qb } as any,
      { findOne: jest.fn().mockResolvedValue({ mbno: '610021030', f_name: 'Rajesh', m_name: 'Kumar', l_name: 'Mishra' }) } as any,
      {} as any,
      dataSource,
      { sortByHeadOrder: async (items: any[]) => items } as any,
    );
  };
  const cdRow = (date: string, amt: number, type = 'CR') => ({ date_key: date, trans_type: type, trans_amt: amt, acc_type: 'CD', code: 'L1004' });

  it('four-column report: opening, every running balance and closing include the carried RD/CD balance', async () => {
    const ds = { query: sqlRouter({ ledgerRows: [cdRow('2019-11-30', 1500), cdRow('2019-12-26', 1500), cdRow('2020-03-31', 405, 'DR')] }) };
    const r = await build(ds).getMemberColumnarLedgerReport({ memberNumber: '610021030', fromDate: '2015-04-02', toDate: '2027-03-31' } as any);
    expect(r.opening.cd).toBe(325715);
    expect(r.rows.map((x: any) => x.cd.bal)).toEqual([327215, 328715, 328310]);
    expect(r.closing.cd).toBe(328310);
  });

  it('four-column report: a later From date opens with carried balance + the rows before it', async () => {
    const ds = { query: sqlRouter({ ledgerRows: [cdRow('2019-11-30', 1500), cdRow('2019-12-26', 1500)] }) };
    const r = await build(ds).getMemberColumnarLedgerReport({ memberNumber: '610021030', fromDate: '2019-12-01', toDate: '2027-03-31' } as any);
    expect(r.opening.cd).toBe(327215);
    expect(r.rows[0].cd.bal).toBe(328715);
  });

  it('four-column report: the carried share balance is added to the share column too', async () => {
    const ds = { query: sqlRouter({ funds: funds({ cd: 0, share: 5000 }), ledgerRows: [] }) };
    const r = await build(ds).getMemberColumnarLedgerReport({ memberNumber: '610021030', fromDate: '2015-04-02', toDate: '2027-03-31' } as any);
    expect(r.opening.share).toBe(5000);
    expect(r.closing.share).toBe(5000);
  });

  it('a member with no fundsmaster row has no carried balance (nothing is added, nothing breaks)', async () => {
    for (const none of [[], undefined as any]) {
      const ds = { query: sqlRouter({ funds: none, ledgerRows: [cdRow('2019-11-30', 1500)] }) };
      const r = await build(ds).getMemberColumnarLedgerReport({ memberNumber: '610021030', fromDate: '2015-04-02', toDate: '2027-03-31' } as any);
      expect(r.opening.cd).toBe(0);
      expect(r.rows[0].cd.bal).toBe(1500);
    }
  });

  it('head-wise detail ledger: L1004 opening = fundsmaster CDOPBAL + ledger rows before the From date', async () => {
    const entry = { l_trans_date: new Date('2019-11-30'), h_head_name: 'COMPULSORY DEPOSIT', l_receipt_vchr_no: 'D00310', l_narration: 'Demand Receipt', l_trans_amt: 1500, l_trans_type: 'CR', l_code: 'L1004', l_acc_type: 'CD' };
    const ds = { query: sqlRouter({ opening: [{ code: 'L1004', opening: '1500' }], ledgerRows: [] }) };
    const r = await build(ds, [entry]).getMemberDetailLedgerReport({ memberNumber: '610021030', fromDate: '2019-12-01', toDate: '2027-03-31' } as any);
    expect(r.openingByCode.L1004).toBe(327215); // 325,715 carried + 1,500 before the From date
  });

  it('head-wise detail ledger: FRS and share heads get their carried balance; heads with none are unchanged', async () => {
    const ds = { query: sqlRouter({ funds: funds({ cd: 0, share: 7000, md: 300, md1: 40 }), opening: [{ code: 'A1002', opening: '12' }] }) };
    const r = await build(ds, []).getMemberDetailLedgerReport({ memberNumber: '610021030', fromDate: '2015-04-02', toDate: '2027-03-31' } as any);
    expect(r.openingByCode).toMatchObject({ L1001: 7000, L1002: 300, L1045: 40, A1002: 12 });
    expect(r.openingByCode.L1004).toBeUndefined(); // CDOPBAL is 0: nothing added
  });
});
