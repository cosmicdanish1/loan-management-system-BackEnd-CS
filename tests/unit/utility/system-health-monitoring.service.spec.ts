import { SystemHealthMonitoringService } from '../../../src/modules/utility/services/system-health-monitoring.service';

// The service is constructed by hand (no Nest module) with a mocked consistency service and a mocked DataSource.
type Biz = { member?: number; loan?: number; deposit?: number; defaulters?: number; loanAmount?: number; deposits?: number; txns?: number };

function build(over: { consistency?: any; dsQuery?: any; biz?: Biz; businessFails?: boolean } = {}) {
  const biz = { member: 100, loan: 40, deposit: 10, defaulters: 0, loanAmount: 1000, deposits: 5000, txns: 5, ...(over.biz || {}) };
  const query = over.dsQuery || jest.fn(async (sql: string) => {
    if (/total_members/.test(sql)) {
      if (over.businessFails) throw new Error('db');
      return [{ total_members: biz.member, active_loans: biz.loan, total_loan_amount: biz.loanAmount, active_deposits: biz.deposit, total_deposit_amount: biz.deposits, daily_transactions: biz.txns, defaulter_count: biz.defaulters }];
    }
    return [{ count: '5' }];
  });
  const consistency = { runConsistencyChecks: jest.fn(async () => over.consistency || { overallStatus: 'HEALTHY', failedChecks: 0, warningChecks: 0, recommendations: [] }) };
  const ds = { isInitialized: true, query };
  const svc = new SystemHealthMonitoringService(consistency as any, ds as any);
  return { svc, ds, consistency };
}

describe('SystemHealthMonitoringService', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('returns database, application, system, business and overall sections', async () => {
    const r = await build().svc.getCurrentHealthStatus();
    expect(Object.keys(r).sort()).toEqual(['application', 'business', 'database', 'overall', 'system', 'timestamp']);
  });

  it('a system with a working database and clean data has no critical issue (host memory may add a warning)', async () => {
    const r = await build().svc.getCurrentHealthStatus();
    expect(r.database.connectionStatus).toBe('HEALTHY');
    expect(r.overall.criticalIssues.filter((x) => /Database|integrity|Error rate/.test(x))).toEqual([]);
    expect(r.overall.score).toBeLessThanOrEqual(100);
  });

  it('pings the database and counts tables', async () => {
    const { svc, ds } = build();
    await svc.getCurrentHealthStatus();
    const sqls = ds.query.mock.calls.map((c: any) => c[0]);
    expect(sqls).toContain('SELECT 1');
    expect(sqls.some((s: string) => /information_schema\.tables/.test(s))).toBe(true);
  });

  it('a database that cannot be reached makes the system DOWN with score 0', async () => {
    const { svc } = build({ dsQuery: jest.fn(async () => { throw new Error('connection refused'); }) });
    const r = await svc.getCurrentHealthStatus();
    expect(r.database.connectionStatus).toBe('CRITICAL');
    expect(r.overall.status).toBe('DOWN');
    expect(r.overall.score).toBe(0);
  });

  it('critical data-integrity issues from the consistency check lower the score and are listed', async () => {
    const { svc } = build({ consistency: { overallStatus: 'CRITICAL_ISSUES', failedChecks: 2, warningChecks: 1, recommendations: [] } });
    const r = await svc.getCurrentHealthStatus();
    expect(r.database.dataIntegrity.status).toBe('CRITICAL_ISSUES');
    expect(r.database.dataIntegrity.issuesCount).toBe(3);
    expect(r.overall.status).toBe('CRITICAL');
    expect(r.overall.criticalIssues).toContain('Critical data integrity issues found');
  });

  it('non-critical issues give WARNING and a 10 point deduction', async () => {
    const { svc } = build({ consistency: { overallStatus: 'ISSUES_FOUND', failedChecks: 0, warningChecks: 2, recommendations: [] } });
    const r = await svc.getCurrentHealthStatus();
    expect(r.overall.status).toBe('WARNING');
    expect(r.overall.warnings).toContain('Data integrity issues found');
  });

  describe('business numbers come from the society\'s real tables (ES-427)', () => {
    it('members, loans, deposits, amounts, transactions and defaulters are read from one query and parsed as numbers', async () => {
      const r = await build({ biz: { member: 150, loan: 30, deposit: 20, loanAmount: 2500000, deposits: 900000, txns: 42, defaulters: 3 } }).svc.getCurrentHealthStatus();
      expect(r.business).toMatchObject({ totalMembers: 150, activeLoans: 30, totalLoanAmount: 2500000, activeDeposits: 20, totalDepositAmount: 900000, dailyTransactions: 42, defaulterCount: 3 });
      expect(r.business.systemUtilization).toBeCloseTo(((30 + 20) / 150) * 100, 5);
    });
    it('values that come back as text (numeric / bigint columns) are converted', async () => {
      const q = jest.fn(async (sql: string) => (/total_members/.test(sql) ? [{ total_members: '7477', active_loans: '12000', total_loan_amount: '123456.50', active_deposits: '0', total_deposit_amount: null, daily_transactions: '0', defaulter_count: '15' }] : [{ count: '5' }]));
      const r = await build({ dsQuery: q }).svc.getCurrentHealthStatus();
      expect(r.business).toMatchObject({ totalMembers: 7477, activeLoans: 12000, totalLoanAmount: 123456.5, totalDepositAmount: 0, defaulterCount: 15 });
    });
    it('the daily transaction count reads the table the society actually posts to (ledger)', async () => {
      const { svc, ds } = build();
      await svc.getCurrentHealthStatus();
      const sql = ds.query.mock.calls.map((c: any) => c[0]).join(' ');
      expect(sql).toMatch(/FROM\s+ledger/i);
      expect(sql).not.toMatch(/FROM\s+transactions/i);
    });
    it('the business metrics read the live member and loan tables, not the empty ORM tables', async () => {
      const { svc, ds } = build();
      await svc.getCurrentHealthStatus();
      const sql = ds.query.mock.calls.map((c: any) => c[0]).join(' ');
      expect(sql).toMatch(/member_master/i);
      expect(sql).toMatch(/loan_master/i);
      expect(sql).not.toMatch(/FROM\s+members\b|FROM\s+loan_accounts\b/i);
    });
    it('a day with no ledger rows and no members does not divide by zero', async () => {
      const r = await build({ biz: { member: 0, loan: 0, deposit: 0, txns: 0 } }).svc.getCurrentHealthStatus();
      expect(Number.isFinite(r.business.systemUtilization)).toBe(true);
    });
    it('too many defaulters (over 10% of active loans) is a warning', async () => {
      const r = await build({ biz: { loan: 40, defaulters: 5 } }).svc.getCurrentHealthStatus();
      expect(r.overall.warnings).toContain('High number of defaulters');
    });
    it('a failure of the business query gives zeroed numbers instead of an error', async () => {
      const r = await build({ businessFails: true }).svc.getCurrentHealthStatus();
      expect(r.business.totalMembers).toBe(0);
      expect(r.database.connectionStatus).toBe('HEALTHY');
    });
  });

  it('recordApiPerformance keeps a running average and counts errors', () => {
    const { svc } = build();
    svc.recordApiPerformance('/x', 'GET', 100);
    svc.recordApiPerformance('/x', 'GET', 300, true);
    const m = svc.getPerformanceMetrics()[0];
    expect(m).toMatchObject({ requestCount: 2, errorCount: 1, averageResponseTime: 200 });
  });

  it('a high error rate (over 10%) is a critical issue', async () => {
    const { svc } = build();
    for (let i = 0; i < 8; i++) svc.recordApiPerformance('/x', 'GET', 10, i < 4);
    const r = await svc.getCurrentHealthStatus();
    expect(r.overall.criticalIssues).toContain('Error rate is too high');
  });

  it('alerts are created once for the same unresolved problem, and can be resolved', async () => {
    const { svc } = build({ dsQuery: jest.fn(async () => { throw new Error('down'); }) });
    await svc.getCurrentHealthStatus();
    await svc.getCurrentHealthStatus();
    const open = svc.getActiveAlerts().filter((a) => a.component === 'Database' && a.message === 'Database connection is critical');
    expect(open).toHaveLength(1);
    expect(svc.resolveAlert(open[0].id)).toBe(true);
    expect(svc.resolveAlert(open[0].id)).toBe(false);
    expect(svc.resolveAlert('nope')).toBe(false);
  });

  it('health history keeps only the last 100 entries', async () => {
    const { svc } = build();
    for (let i = 0; i < 103; i++) await svc.getCurrentHealthStatus();
    expect(svc.getHealthHistory(24).length).toBe(100);
  });

  it('diagnostics merge health and consistency recommendations without duplicates', async () => {
    const { svc } = build({ consistency: { overallStatus: 'ISSUES_FOUND', failedChecks: 0, warningChecks: 1, recommendations: ['Run data correction', 'Run data correction'] } });
    const r = await svc.runSystemDiagnostics();
    expect(r.recommendations.filter((x) => x === 'Run data correction')).toHaveLength(1);
  });
});
