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

// The old-rate payroll-lag payment (real money the member already paid,
// deducted against the closed-out predecessor loan by BSP's payroll system
// before it could switch to the new consolidated loan's rate) is excluded
// from the new loan's own installment schedule/pooling, but it still needs
// to be credited back against what the member owes at closure -- via the
// app's own `adjustment` parameter, exactly as designed for this.
const CASES: { case: string; lagPrincipal: number; lagInterest: number }[] = [
    { case: '19578', lagPrincipal: 6000, lagInterest: 1650 },   // 610026821
    { case: '19603', lagPrincipal: 7317, lagInterest: 1706 },   // 610033146 ALN
    { case: '18445', lagPrincipal: 6667, lagInterest: 1895 },   // 610033022 ALN
    { case: '15555', lagPrincipal: 16667, lagInterest: 5417 },  // 610033022 RLN
];

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const repaymentSvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);

    const closureDate = new Date(2026, 9, 5);
    for (const c of CASES) {
        const adjustment = -(c.lagPrincipal + c.lagInterest);
        const noAdj = await repaymentSvc.calculateEarlyClosure(c.case, closureDate, 0, false);
        const withAdj = await repaymentSvc.calculateEarlyClosure(c.case, closureDate, adjustment, false);
        console.log(`\n${c.case}: without credit = ${noAdj.finalClosureAmount.toLocaleString('en-IN')}, `
            + `lag payment credit = -${(c.lagPrincipal + c.lagInterest).toLocaleString('en-IN')} `
            + `(principal ${c.lagPrincipal} + interest ${c.lagInterest})`);
        console.log(`   >>> WITH CREDIT (real, via app's own adjustment param): ${withAdj.finalClosureAmount.toLocaleString('en-IN')}`);
    }
    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
