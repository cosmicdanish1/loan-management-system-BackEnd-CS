import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';
import * as fs from 'fs';

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const CASES: { case: string; lagPrincipal: number; lagInterest: number; lagDate: string }[] = [
    { case: '19578', lagPrincipal: 6000, lagInterest: 1650, lagDate: '08-Jul-2025' },
    { case: '19603', lagPrincipal: 7317, lagInterest: 1706, lagDate: '08-Jul-2025' },
    { case: '18445', lagPrincipal: 6667, lagInterest: 1895, lagDate: '15-Jul-2024' },
    { case: '15555', lagPrincipal: 16667, lagInterest: 5417, lagDate: '15-Jul-2024' },
];

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const repaymentSvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);

    const closureDate = new Date(2026, 9, 5);
    const out: Record<string, any> = {};
    for (const c of CASES) {
        const adjustment = -(c.lagPrincipal + c.lagInterest);
        const q = await repaymentSvc.calculateEarlyClosure(c.case, closureDate, adjustment, false);
        out[c.case] = { ...q, lagPrincipal: c.lagPrincipal, lagInterest: c.lagInterest, lagDate: c.lagDate };
        console.log(c.case, '->', q.finalClosureAmount);
    }
    fs.writeFileSync(
        'C:/Users/Danis/AppData/Local/Temp/claude/F--company-main-project/22c394ba-8eb5-4c99-be8f-ae1e2a7633f7/scratchpad/final_adjusted_quotes.json',
        JSON.stringify(out, null, 1)
    );
    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
