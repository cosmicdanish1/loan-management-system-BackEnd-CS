import { JottingReportService } from '../../../src/modules/jotting-report/jotting-report.service';

const build = (result: any[] | Error = []) => {
  const dataSource: any = {
    query: result instanceof Error
      ? jest.fn().mockRejectedValue(result)
      : jest.fn().mockResolvedValue(result),
  };
  return { service: new JottingReportService(dataSource), dataSource };
};

describe('JottingReportService lists', () => {
  it('returns head masters as selected', async () => {
    const rows = [{ code: 'A1001', headName: 'Cash in Hand', headtype: 'A', parentCode: null }];
    const { service } = build(rows);
    await expect(service.getHeadMasters()).resolves.toEqual(rows);
  });

  it('reduces the wing list to wing names', async () => {
    const { service } = build([{ wingNo: 1, wingName: 'Main' }, { wingNo: 2, wingName: 'North' }]);
    await expect(service.getWingList()).resolves.toEqual(['Main', 'North']);
  });

  it('returns office numbers as strings', async () => {
    const { service } = build([{ officeNo: 1 }, { officeNo: 12 }]);
    await expect(service.getOfficeList()).resolves.toEqual(['1', '12']);
  });

  it.each([
    ['getHeadMasters', /Failed to fetch head masters/],
    ['getWingList', /Failed to fetch wings/],
    ['getOfficeList', /Failed to fetch offices/],
  ])('wraps a database failure from %s', async (method, message) => {
    const { service } = build(new Error('db down'));
    await expect((service as any)[method]()).rejects.toThrow(message as RegExp);
  });
});

describe('JottingReportService report', () => {
  it('binds the head and the as-on date first and defaults to member-number order', async () => {
    const { service, dataSource } = build([
      { memberNo: 1001, memberName: 'Asha Patil', wing: 'Main', office: '1', balance: '250.00' },
    ]);

    const rows = await service.getJottingReport({ headCode: 'L1001', asOnDate: '2026-09-30' });

    expect(rows).toHaveLength(1);
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(params).toEqual(['L1001', '2026-09-30']);
    expect(sql).toContain('l.code = $1');
    expect(sql).toContain('l.trans_date <= $2::date');
    expect(sql).toContain('ORDER BY mm.mbno');
  });

  it('adds the wing and office filters as bound parameters $3 and $4', async () => {
    const { service, dataSource } = build();
    await service.getJottingReport({
      headCode: 'L1001', asOnDate: '2026-09-30', wingName: 'Main', officeName: '12',
    });

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('wm.wname = $3');
    expect(sql).toContain('mm.officeno::text = $4');
    expect(params).toEqual(['L1001', '2026-09-30', 'Main', '12']);
  });

  it('sorts by member name only when asked', async () => {
    const { service, dataSource } = build();
    await service.getJottingReport({ headCode: 'L1001', asOnDate: '2026-09-30', sortBy: 'Name' });
    expect(dataSource.query.mock.calls[0][0]).toContain('ORDER BY "memberName"');
  });

  it('counts legacy receipt/payment rows in the member balance, like the Day Book does', async () => {
    const { service, dataSource } = build();
    await service.getJottingReport({ headCode: 'L1001', asOnDate: '2026-09-30' });

    const sql = dataSource.query.mock.calls[0][0];
    expect(sql).toContain("l.trans_type IN ('CR', 'R')");
    expect(sql).toContain("l.trans_type IN ('DR', 'P')");
  });

  it("uses the head's own normal direction for the balance sign", async () => {
    const { service, dataSource } = build();
    await service.getJottingReport({ headCode: 'A1002', asOnDate: '2026-09-30' });

    const statements = dataSource.query.mock.calls.map(([sql]: any) => String(sql));
    // A loan head is debit-normal: a member who owes 5,000 must show +5,000, not -5,000.
    expect(statements.some((sql) => /headmaster/i.test(sql) && /pflag/i.test(sql))).toBe(true);
  });

  it('wraps a report query failure', async () => {
    const { service } = build(new Error('db down'));
    await expect(service.getJottingReport({ headCode: 'L1001', asOnDate: '2026-09-30' }))
      .rejects.toThrow(/Failed to generate jotting report/);
  });
});
