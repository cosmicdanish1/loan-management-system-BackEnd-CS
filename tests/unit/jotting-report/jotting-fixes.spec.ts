import { JottingReportService } from '../../../src/modules/jotting-report/jotting-report.service';

const run = async () => {
  const ds: any = { query: jest.fn().mockResolvedValue([]) };
  await new JottingReportService(ds).getJottingReport({ headCode: 'A1002', asOnDate: '2026-09-30' });
  return ds.query.mock.calls[0][0] as string;
};

describe('Jotting report balance (ES-422)', () => {
  it('legacy R counts as credit and P as debit, CR/DR unchanged, other types ignored', async () => {
    const sql = await run();
    expect(sql).toContain("WHEN l.trans_type IN ('CR', 'R') THEN l.trans_amt::numeric");
    expect(sql).toContain("WHEN l.trans_type IN ('DR', 'P') THEN -l.trans_amt::numeric");
    expect(sql).toContain('ELSE 0');
  });
  it('the sign comes from the head pflag (A/E flip the sign) in the same single query, with the head code bound', async () => {
    const ds: any = { query: jest.fn().mockResolvedValue([]) };
    await new JottingReportService(ds).getJottingReport({ headCode: 'A1002', asOnDate: '2026-09-30' });
    expect(ds.query).toHaveBeenCalledTimes(1);
    const [sql, params] = ds.query.mock.calls[0];
    expect(sql).toMatch(/FROM headmaster h WHERE h\.code = \$1/);
    expect(sql).toMatch(/IN \('A', 'E'\) THEN -1 ELSE 1/);
    expect(params).toEqual(['A1002', '2026-09-30']);
  });
});
