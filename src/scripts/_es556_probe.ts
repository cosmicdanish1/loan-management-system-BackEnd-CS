import 'dotenv/config';
// ES-556 probe: for active loans, compare the normal quote with the next-month quote (read-only; the hold plan is a
// dry run that is rolled back). Usage: npx ts-node --transpile-only src/scripts/_es556_probe.ts [limit]
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    const limit = Number(process.argv[2] || 25);
    await ds.initialize();
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const svc = new LoanRepaymentService(ds, new LoanEligibilityService(ds, rdEvents, rdRules), rdEvents);

    const loans = await ds.query(
        `SELECT mbno::text mbno, loancaseno::text AS loancaseno, loantype, balance::float balance, instal_amt::float emi, no_of_instal
           FROM loan_master WHERE balance > 0 AND consolidated_into_loancaseno IS NULL AND loantype IN ('RLN','ALN')
           ORDER BY payment_date DESC NULLS LAST LIMIT $1`, [limit]);
    let shown = 0;
    for (const l of loans) {
        try {
            const normal = await svc.calculateEarlyClosure(l.loancaseno, undefined, 0, false, l.mbno);
            let next: any;
            try { next = await svc.calculateEarlyClosure(l.loancaseno, undefined, 0, false, l.mbno, false, true); }
            catch (e: any) { console.log(`${l.mbno}/${l.loancaseno} normal=${normal.finalClosureAmount} next-month REFUSED: ${e.message}`); continue; }
            console.log(`${l.mbno}/${l.loancaseno} ${l.loantype} bal=${l.balance} emi=${l.emi} | normal: principal=${normal.outstandingPrincipal} interest=${normal.closureInterest} penal=${normal.penalInterest} final=${normal.finalClosureAmount}`
                + ` | NEXT-MONTH: principal=${next.outstandingPrincipal} interest=${next.closureInterest} penal=${next.penalInterest} final=${next.finalClosureAmount} emiPrincipal=${next.nextMonthInfo?.principal} grace=${next.nextMonthInfo?.wasInGrace}`);
            shown++;
        } catch (e: any) { console.log(`${l.mbno}/${l.loancaseno} quote error: ${e.message}`); }
    }
    console.log('compared', shown, 'of', loans.length);
    await ds.destroy();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
