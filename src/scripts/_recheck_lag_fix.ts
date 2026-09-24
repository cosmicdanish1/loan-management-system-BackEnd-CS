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
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const repaymentSvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);

    const closureDate = new Date(2026, 9, 5);
    for (const c of ['19578', '19603', '18445', '15555']) {
        const q = await repaymentSvc.calculateEarlyClosure(c, closureDate, 0, false);
        console.log(`\n${c}: outstanding=${q.outstandingPrincipal} nrInt=${q.nrInterest} `
            + `apInt=${q.apInterest} (${q.futureInstallmentCount} future) closureInt=${q.closureInterest} `
            + `penal=${q.penalInterest} paidInstal=${q.paidInstallments}`);
        console.log(`   >>> FINAL CLOSURE AMOUNT: ${q.finalClosureAmount.toLocaleString('en-IN')}`);
        console.log(`   unpaid:`, q.unpaidInstallments.map((u: any) =>
            `#${u.installmentNo} due ${u.dueDate} p=${u.principalDue} i=${u.interestDue} pen=${u.penalDue} tier=${u.tier}`));
    }
    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
