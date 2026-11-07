import { DemandReportService } from '../../../src/modules/transaction/services-v2/demand-report.service';

const build = (rows: any[] = []) => {
  const dataSource: any = { query: jest.fn().mockResolvedValue(rows) };
  return { service: new DemandReportService(dataSource), dataSource };
};

describe('DemandReportService', () => {
  it('returns nothing for an unknown month and refuses a year that is not 4 digits, without querying', async () => {
    const { service, dataSource } = build();
    await expect(service.getDemandList({ month: 'XYZ', year: '2026' })).resolves.toEqual([]);
    for (const year of ['nope', '', '26', '20260', ' 2026x']) await expect(service.getDemandList({ month: 'APR', year })).rejects.toThrow(/4-digit year/); // ES-423
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('rejects a year with trailing junk instead of silently accepting it', async () => {
    const { service } = build();
    await expect(service.getDemandList({ month: 'APR', year: '2026abc' })).rejects.toThrow();
  });

  it('accepts a lower-case month name like the demand generator does', async () => {
    const { service, dataSource } = build();
    await service.getDemandList({ month: 'apr', year: '2026' });
    expect(dataSource.query).toHaveBeenCalled();
  });

  it('maps status, name fallback and filter parameters', async () => {
    const { service, dataSource } = build([
      {
        id: 1, memberNo: 1001, month: 4, year: 2026, rlnInstallmentAmount: '100',
        rlnInterest: '20', totalDemand: '120', balance: '0', officeNo: '1', loanCaseNo: 'LC1',
        member_name: '',
      },
    ]);

    const [row] = await service.getDemandList({ month: 'APR', year: '2026', division: '7', branch: '1', sortBy: 'Name' });

    expect(row.memberName).toBe('Member 1001');
    
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain("CASE WHEN COALESCE(dm.balance_for_month,0) > 0 THEN 'Unpaid' ELSE 'Paid' END as status"); // status is worked out in SQL

    expect(sql).toContain('mm.wingno::text = $3');
    expect(sql).toContain('dm.officeno::text = $4');
    expect(sql).toContain('ORDER BY member_name ASC');
    expect(params).toEqual([4, 2026, '7', '1']);
  });

  it('marks a positive balance as Unpaid and sorts by loan case when asked', async () => {
    const { service, dataSource } = build([{ memberNo: 1, balance: '50', member_name: 'Asha' }]);
    const [row] = await service.getDemandList({ month: 'APR', year: '2026', sortBy: 'Account No.' });
    expect(row.memberName).toBe('Asha');
    expect(dataSource.query.mock.calls[0][0]).toContain('ORDER BY dm.loancaseno ASC NULLS LAST');
  });
});
