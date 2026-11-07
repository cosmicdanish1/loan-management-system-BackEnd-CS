import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface ConsistencyCheckResult {
  checkName: string;
  status: 'PASS' | 'FAIL' | 'WARNING';
  message: string;
  affectedRecords: number;
  details?: any[];
  fixAvailable: boolean;
}

export interface DataConsistencyReport {
  overallStatus: 'HEALTHY' | 'ISSUES_FOUND' | 'CRITICAL_ISSUES';
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  warningChecks: number;
  checks: ConsistencyCheckResult[];
  generatedAt: Date;
  recommendations: string[];
}

export interface OrphanedRecordsCheck {
  orphanedLoans: any[];
  orphanedDeposits: any[];
  orphanedPayments: any[];
  orphanedTransactions: any[];
}

export interface BalanceDiscrepancy {
  memberId: number;
  memberName: string;
  accountType: string;
  accountId: number;
  calculatedBalance: number;
  recordedBalance: number;
  discrepancy: number;
  lastTransaction: Date;
}

const SAMPLE = 20;

/**
 * Read-only data checks on the tables the society actually works in: member_master, member_balances,
 * loan_master and ledger (ES-427). They used to run on the empty ORM tables, so the answer was always HEALTHY.
 * Nothing here changes data. "fixAvailable" is false everywhere: the automatic correction tools are switched off
 * (see DataCorrectionService) because a wrong automatic fix on real accounts is worse than a reported problem.
 */
@Injectable()
export class DataConsistencyService {
  private readonly logger = new Logger(DataConsistencyService.name);

  constructor(private dataSource: DataSource) { }

  async runConsistencyChecks(): Promise<DataConsistencyReport> {
    this.logger.log('Starting data consistency checks');
    const checks: ConsistencyCheckResult[] = [];
    checks.push(await this.checkOrphanedRecords());
    checks.push(await this.checkBalanceConsistency());
    checks.push(await this.checkDuplicateRecords());
    checks.push(await this.checkDataIntegrity());
    checks.push(await this.checkBusinessRuleViolations());
    checks.push(await this.checkReferentialIntegrity());
    checks.push(await this.checkDateConsistency());
    checks.push(await this.checkNumericalConsistency());

    const passedChecks = checks.filter(c => c.status === 'PASS').length;
    const failedChecks = checks.filter(c => c.status === 'FAIL').length;
    const warningChecks = checks.filter(c => c.status === 'WARNING').length;
    const overallStatus: DataConsistencyReport['overallStatus'] =
      failedChecks > 0 ? 'CRITICAL_ISSUES' : warningChecks > 0 ? 'ISSUES_FOUND' : 'HEALTHY';

    return {
      overallStatus,
      totalChecks: checks.length,
      passedChecks,
      failedChecks,
      warningChecks,
      checks,
      generatedAt: new Date(),
      recommendations: this.generateRecommendations(checks),
    };
  }

  /** Runs the queries of one check and turns their row counts into a result; a failing query is a FAIL, never a silent PASS. */
  private async runCheck(
    checkName: string,
    issueStatus: 'FAIL' | 'WARNING',
    parts: Array<{ label: string; countSql: string; sampleSql: string }>,
    passMessage: string,
  ): Promise<ConsistencyCheckResult> {
    try {
      const details: any[] = [];
      let total = 0;
      const found: string[] = [];
      for (const p of parts) {
        const count = Number((await this.dataSource.query(p.countSql))[0]?.n) || 0;
        if (count > 0) {
          total += count;
          found.push(`${count} ${p.label}`);
          const sample = await this.dataSource.query(p.sampleSql);
          details.push({ issue: p.label, count, sample });
        }
      }
      return {
        checkName,
        status: total > 0 ? issueStatus : 'PASS',
        message: total > 0 ? `Found ${found.join('; ')}` : passMessage,
        affectedRecords: total,
        details: total > 0 ? details : undefined,
        fixAvailable: false,
      };
    } catch (error: any) {
      this.logger.error(`${checkName} failed: ${error.message}`);
      return { checkName, status: 'FAIL', message: 'This check could not be run. See the server log.', affectedRecords: 0, fixAvailable: false };
    }
  }

  async checkOrphanedRecords(): Promise<ConsistencyCheckResult> {
    return this.runCheck('Orphaned Records Check', 'WARNING', [
      {
        label: 'loans whose member does not exist',
        countSql: `SELECT count(*) AS n FROM loan_master l WHERE NOT EXISTS (SELECT 1 FROM member_master m WHERE m.mbno::text = l.mbno::text)`,
        sampleSql: `SELECT l.mbno::text AS member_no, l.loancaseno::text AS loan_case_no, l.loantype FROM loan_master l WHERE NOT EXISTS (SELECT 1 FROM member_master m WHERE m.mbno::text = l.mbno::text) ORDER BY l.loancaseno LIMIT ${SAMPLE}`,
      },
      {
        label: 'member balance rows whose member does not exist',
        countSql: `SELECT count(*) AS n FROM member_balances b WHERE b.mbno IS NULL OR NOT EXISTS (SELECT 1 FROM member_master m WHERE m.mbno::text = b.mbno::text)`,
        sampleSql: `SELECT b.mbno::text AS member_no, b.member_name FROM member_balances b WHERE b.mbno IS NULL OR NOT EXISTS (SELECT 1 FROM member_master m WHERE m.mbno::text = b.mbno::text) LIMIT ${SAMPLE}`,
      },
      {
        label: 'ledger rows posted to a member that does not exist',
        countSql: `SELECT count(*) AS n FROM ledger g WHERE g.mbno IS NOT NULL AND g.mbno > 0 AND NOT EXISTS (SELECT 1 FROM member_master m WHERE m.mbno = g.mbno)`,
        sampleSql: `SELECT g.mbno::text AS member_no, count(*) AS rows FROM ledger g WHERE g.mbno IS NOT NULL AND g.mbno > 0 AND NOT EXISTS (SELECT 1 FROM member_master m WHERE m.mbno = g.mbno) GROUP BY g.mbno ORDER BY count(*) DESC LIMIT ${SAMPLE}`,
      },
    ], 'No loans, balances or postings point to a missing member');
  }

  /** Books must balance: total debits equal total credits across the whole ledger. */
  async checkBalanceConsistency(): Promise<ConsistencyCheckResult> {
    try {
      const r = await this.dataSource.query(
        `SELECT COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN trans_amt ELSE 0 END), 0) AS dr,
                COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN trans_amt ELSE 0 END), 0) AS cr
           FROM ledger`);
      const dr = Number(r[0].dr), cr = Number(r[0].cr);
      const diff = Math.round((dr - cr) * 100) / 100;
      return {
        checkName: 'Balance Consistency Check',
        status: diff === 0 ? 'PASS' : 'WARNING',
        message: diff === 0
          ? 'Total debits equal total credits in the ledger'
          : `Ledger debits and credits differ by ${Math.abs(diff).toLocaleString('en-IN')} (${diff > 0 ? 'debits higher' : 'credits higher'})`,
        affectedRecords: diff === 0 ? 0 : 1,
        details: diff === 0 ? undefined : [{ totalDebits: dr, totalCredits: cr, difference: diff }],
        fixAvailable: false,
      };
    } catch (error: any) {
      this.logger.error(`Balance consistency check failed: ${error.message}`);
      return { checkName: 'Balance Consistency Check', status: 'FAIL', message: 'This check could not be run. See the server log.', affectedRecords: 0, fixAvailable: false };
    }
  }

  async checkDuplicateRecords(): Promise<ConsistencyCheckResult> {
    return this.runCheck('Duplicate Records Check', 'WARNING', [
      {
        label: 'member numbers used more than once',
        countSql: `SELECT count(*) AS n FROM (SELECT mbno FROM member_master GROUP BY mbno HAVING count(*) > 1) x`,
        sampleSql: `SELECT mbno::text AS member_no, count(*) AS rows FROM member_master GROUP BY mbno HAVING count(*) > 1 ORDER BY mbno LIMIT ${SAMPLE}`,
      },
      {
        label: 'loans repeated for the same member, case number and type',
        countSql: `SELECT count(*) AS n FROM (SELECT 1 FROM loan_master GROUP BY mbno, loancaseno, loantype HAVING count(*) > 1) x`,
        sampleSql: `SELECT mbno::text AS member_no, loancaseno::text AS loan_case_no, loantype, count(*) AS rows FROM loan_master GROUP BY mbno, loancaseno, loantype HAVING count(*) > 1 ORDER BY loancaseno LIMIT ${SAMPLE}`,
      },
      {
        label: 'member balance rows repeated for one member',
        countSql: `SELECT count(*) AS n FROM (SELECT mbno FROM member_balances WHERE mbno IS NOT NULL GROUP BY mbno HAVING count(*) > 1) x`,
        sampleSql: `SELECT mbno::text AS member_no, count(*) AS rows FROM member_balances WHERE mbno IS NOT NULL GROUP BY mbno HAVING count(*) > 1 ORDER BY mbno LIMIT ${SAMPLE}`,
      },
    ], 'No repeated members, loans or balance rows');
  }

  async checkDataIntegrity(): Promise<ConsistencyCheckResult> {
    return this.runCheck('Data Integrity Check', 'FAIL', [
      {
        label: 'members without a name',
        countSql: `SELECT count(*) AS n FROM member_master WHERE COALESCE(TRIM(f_name), '') = ''`,
        sampleSql: `SELECT mbno::text AS member_no FROM member_master WHERE COALESCE(TRIM(f_name), '') = '' ORDER BY mbno LIMIT ${SAMPLE}`,
      },
      {
        label: 'open loans with a loan amount of zero or less',
        countSql: `SELECT count(*) AS n FROM loan_master WHERE CAST(balance AS numeric) > 0 AND COALESCE(CAST(loan_amt AS numeric), 0) <= 0`,
        sampleSql: `SELECT mbno::text AS member_no, loancaseno::text AS loan_case_no, loan_amt FROM loan_master WHERE CAST(balance AS numeric) > 0 AND COALESCE(CAST(loan_amt AS numeric), 0) <= 0 ORDER BY loancaseno LIMIT ${SAMPLE}`,
      },
      {
        label: 'loans whose balance is more than the loan amount',
        countSql: `SELECT count(*) AS n FROM loan_master WHERE CAST(balance AS numeric) > CAST(loan_amt AS numeric)`,
        sampleSql: `SELECT mbno::text AS member_no, loancaseno::text AS loan_case_no, loan_amt, balance FROM loan_master WHERE CAST(balance AS numeric) > CAST(loan_amt AS numeric) ORDER BY loancaseno LIMIT ${SAMPLE}`,
      },
    ], 'Members and loans have the details they need');
  }

  async checkBusinessRuleViolations(): Promise<ConsistencyCheckResult> {
    return this.runCheck('Business Rule Violations Check', 'WARNING', [
      {
        label: 'loans disbursed on a future date',
        countSql: `SELECT count(*) AS n FROM loan_master WHERE payment_date > CURRENT_DATE + 1`,
        sampleSql: `SELECT mbno::text AS member_no, loancaseno::text AS loan_case_no, payment_date FROM loan_master WHERE payment_date > CURRENT_DATE + 1 ORDER BY payment_date DESC LIMIT ${SAMPLE}`,
      },
      {
        label: 'loans with an installment amount but no installment count',
        countSql: `SELECT count(*) AS n FROM loan_master WHERE CAST(balance AS numeric) > 0 AND CAST(instal_amt AS numeric) > 0 AND COALESCE(no_of_instal, 0) <= 0`,
        sampleSql: `SELECT mbno::text AS member_no, loancaseno::text AS loan_case_no, instal_amt, no_of_instal FROM loan_master WHERE CAST(balance AS numeric) > 0 AND CAST(instal_amt AS numeric) > 0 AND COALESCE(no_of_instal, 0) <= 0 ORDER BY loancaseno LIMIT ${SAMPLE}`,
      },
    ], 'No loan breaks a basic business rule');
  }

  async checkReferentialIntegrity(): Promise<ConsistencyCheckResult> {
    return this.runCheck('Referential Integrity Check', 'WARNING', [
      {
        label: 'loans with a balance for an inactive member',
        countSql: `SELECT count(*) AS n FROM loan_master l JOIN member_master m ON m.mbno::text = l.mbno::text WHERE m.isactive = 'N' AND CAST(l.balance AS numeric) > 0`,
        sampleSql: `SELECT l.mbno::text AS member_no, l.loancaseno::text AS loan_case_no, l.balance FROM loan_master l JOIN member_master m ON m.mbno::text = l.mbno::text WHERE m.isactive = 'N' AND CAST(l.balance AS numeric) > 0 ORDER BY l.loancaseno LIMIT ${SAMPLE}`,
      },
    ], 'No loan is left open for an inactive member');
  }

  async checkDateConsistency(): Promise<ConsistencyCheckResult> {
    return this.runCheck('Date Consistency Check', 'WARNING', [
      {
        label: 'ledger rows dated in the future',
        countSql: `SELECT count(*) AS n FROM ledger WHERE trans_date > CURRENT_DATE + 1`,
        sampleSql: `SELECT trans_no::text AS trans_no, trans_date, trans_type, trans_amt, mbno::text AS member_no FROM ledger WHERE trans_date > CURRENT_DATE + 1 ORDER BY trans_date DESC LIMIT ${SAMPLE}`,
      },
      {
        label: 'ledger rows dated before 1990',
        countSql: `SELECT count(*) AS n FROM ledger WHERE trans_date < DATE '1990-01-01'`,
        sampleSql: `SELECT trans_no::text AS trans_no, trans_date, trans_type, trans_amt FROM ledger WHERE trans_date < DATE '1990-01-01' ORDER BY trans_date LIMIT ${SAMPLE}`,
      },
    ], 'All ledger dates are sensible');
  }

  async checkNumericalConsistency(): Promise<ConsistencyCheckResult> {
    return this.runCheck('Numerical Consistency Check', 'FAIL', [
      {
        label: 'ledger rows with an amount of zero or less',
        countSql: `SELECT count(*) AS n FROM ledger WHERE trans_amt <= 0`,
        sampleSql: `SELECT trans_no::text AS trans_no, trans_date, trans_type, trans_amt, mbno::text AS member_no, narration FROM ledger WHERE trans_amt <= 0 ORDER BY trans_date DESC LIMIT ${SAMPLE}`,
      },
      {
        label: 'loans with a negative balance',
        countSql: `SELECT count(*) AS n FROM loan_master WHERE CAST(balance AS numeric) < 0`,
        sampleSql: `SELECT mbno::text AS member_no, loancaseno::text AS loan_case_no, balance FROM loan_master WHERE CAST(balance AS numeric) < 0 ORDER BY loancaseno LIMIT ${SAMPLE}`,
      },
      {
        label: 'members with a negative share or deposit balance',
        countSql: `SELECT count(*) AS n FROM member_balances WHERE shares < 0 OR compulsory_deposit < 0 OR rd_amt < 0`,
        sampleSql: `SELECT mbno::text AS member_no, shares, compulsory_deposit, rd_amt FROM member_balances WHERE shares < 0 OR compulsory_deposit < 0 OR rd_amt < 0 ORDER BY mbno LIMIT ${SAMPLE}`,
      },
    ], 'No amount is zero or negative where it should not be');
  }

  private generateRecommendations(checks: ConsistencyCheckResult[]): string[] {
    const recommendations: string[] = [];
    const failed = checks.filter(c => c.status === 'FAIL');
    const warnings = checks.filter(c => c.status === 'WARNING');
    if (failed.length > 0) {
      recommendations.push('Review the failed checks first: they point at wrong amounts or missing details');
      recommendations.push('Take a database backup before correcting any record by hand');
    }
    if (warnings.length > 0) recommendations.push('Review the warnings and decide which need a correction');
    if (checks.some(c => c.checkName.includes('Balance') && c.status !== 'PASS')) {
      recommendations.push('Find the entry that keeps debits and credits apart (Day Book / Ledger reports by date)');
    }
    if (failed.length === 0 && warnings.length === 0) recommendations.push('Data looks consistent - keep checking regularly');
    return recommendations;
  }
}
