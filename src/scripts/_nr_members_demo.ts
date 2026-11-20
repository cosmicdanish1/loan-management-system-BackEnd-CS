import 'dotenv/config';
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// READ ONLY. Lists members whose loans Phase 2 has finished and that have unpaid (NR) instalments, using the app's own
// getDueStatus, as input for picking demo members. Writes nothing.
const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    await ds.initialize();
    const rdRules = new RdRulesService(ds);
    const rdBal = new RdBalanceEventsService(ds, rdRules);
    const elig = new LoanEligibilityService(ds, rdBal, rdRules);
    const svc = new LoanRepaymentService(ds, elig, rdBal);
    const cases = await ds.query(`
        SELECT lm.mbno::text AS mbno, lm.loancaseno::text AS caseno, upper(lm.loantype) AS lt, lm.balance::numeric AS bal
          FROM loan_master lm
         WHERE lm.balance::numeric > 0
           AND lm.mbno::numeric IN (SELECT mbno::numeric FROM legacy_replay_batch_log WHERE status = 'done' AND dry_run = false)
           AND lm.mbno::numeric NOT IN (SELECT mbno::numeric FROM loan_master WHERE balance::numeric > 0 GROUP BY mbno, upper(loantype) HAVING count(*) > 1)
         ORDER BY lm.mbno, lm.loancaseno`);
    const out: any[] = [];
    for (const c of cases) {
        try {
            const d: any = await svc.getDueStatus(c.caseno, new Date());
            const n = d.unpaidInstallments.length;
            if (n > 0) out.push({ mbno: c.mbno, caseno: c.caseno, type: c.lt, balance: Number(c.bal), nr: n, nrPrincipal: d.totalPrincipalDue, nrInterest: d.totalInterestDue, penal: d.totalPenalDue, oldest: d.unpaidInstallments[0]?.dueDate });
        } catch { /* shared case numbers etc.: skip */ }
    }
    console.log(JSON.stringify({ casesChecked: cases.length, withNr: out.length, rows: out }));
    await ds.destroy();
}
main().catch(e => { console.error(e); process.exit(1); });
