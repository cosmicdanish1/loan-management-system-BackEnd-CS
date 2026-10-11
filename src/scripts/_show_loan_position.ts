import 'dotenv/config';
// Prints the Loan Position (read-only) for one loan, exactly what the new panel shows.
// Usage: npx ts-node --transpile-only src/scripts/_show_loan_position.ts <mbno> <loancaseno> [yyyy-mm-dd]
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { LoanPositionService } from '../modules/loan/services-v2/loan-position.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    const [mbno, caseNo, dateArg] = process.argv.slice(2);
    await ds.initialize();
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const repay = new LoanRepaymentService(ds, new LoanEligibilityService(ds, rdEvents, rdRules), rdEvents);
    const svc = new LoanPositionService(ds, repay);
    const p: any = await svc.getPosition(mbno, caseNo, undefined, dateArg ? new Date(`${dateArg}T10:00:00+05:30`) : undefined);
    console.log(JSON.stringify(p, null, 2));
    await ds.destroy();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
