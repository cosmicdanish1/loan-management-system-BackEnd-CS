import { ConsolidationService } from '../../../src/modules/consolidation/consolidation.service';

describe('Consolidation legacy R/P rows (ES-422)', () => {
  const run = async (rows: any[]) => {
    const calls: string[] = [];
    const repo: any = { query: jest.fn(async (sql: string) => { calls.push(sql); return /DISTINCT ON/.test(sql) ? rows : [{ balance: '0', cash_in: '0', cash_out: '0' }]; }) };
    const svc = new ConsolidationService(repo, { findOne: jest.fn() } as any, { sortByHeadOrder: jest.fn(async (i: any) => i) } as any);
    return { calls, report: await svc.getConsolidationReport({ date: '2026-09-20' } as any) };
  };
  const row = (o: any) => ({ ledgerid: 1, head_code: 'L1', head_name: 'H', trans_type: 'CR', amount: '10', mb_no: '1', member_name: 'A', ...o });
  it('R and CR are receipts, P and DR are payments, grouped per head', async () => {
    const { report } = await run([row({ ledgerid: 1, trans_type: 'R', amount: '30' }), row({ ledgerid: 2, trans_type: 'CR', amount: '5' }), row({ ledgerid: 3, trans_type: 'P', amount: '10' }), row({ ledgerid: 4, trans_type: 'DR', amount: '2' })]);
    expect(report.receiptGroups[0].total).toBe(35);
    expect(report.paymentGroups[0].total).toBe(12);
  });
  it('the cash-in-hand opening balance and day movement SQL count legacy P as debit and R as credit', async () => {
    const { calls } = await run([]);
    const sql = calls.join('\n');
    expect(sql).toContain("trans_type IN ('DR', 'P') THEN");
    expect(sql).toContain("trans_type IN ('CR', 'R') THEN");
    expect(sql).not.toMatch(/trans_type = 'DR'|trans_type = 'CR'/);
  });
});
