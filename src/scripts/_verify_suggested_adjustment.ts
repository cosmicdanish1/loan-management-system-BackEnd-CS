import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBal = new RdBalanceEventsService(AppDataSource, rdRules);
    const elig = new LoanEligibilityService(AppDataSource, rdBal, rdRules);
    const svc = new LoanRepaymentService(AppDataSource, elig, rdBal);
    for (const c of ['19578', '19603', '18445', '15555']) {
        const q = await svc.calculateEarlyClosure(c, new Date(2026, 9, 5), 0, false);
        console.log(`${c} -> suggestedAdjustment=${q.suggestedAdjustment}  finalClosureAmount=${q.finalClosureAmount} (gross, pre-credit)`);
    }
    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
