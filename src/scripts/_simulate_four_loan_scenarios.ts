import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Runs the REAL app code (LoanRepaymentService) against the real, live
// consolidated loan case 778004 (mbno 900000501 — the synthetic stand-in for
// real legacy member 30033124's 4 real ALN loans, already consolidated by
// pass-transaction.service.ts's new consolidation logic) to produce two
// scenarios with zero hand-arithmetic:
//   1. The next upcoming EMI (installment #1 of the combined schedule)
//   2. What full closure would cost today (calculateEarlyClosure)
// getInstallmentStatus is private, so it's invoked via bracket access on the
// real service instance — this calls the actual method, not a re-implementation.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const LOANCASENO = '778004';
const TODAY = new Date(2026, 8, 17); // 17-Sep-2026, real session date

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const repaymentSvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);

    const loanRows = await AppDataSource.query(
        `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date
         FROM loan_master WHERE loancaseno::text = $1`,
        [LOANCASENO]
    );
    const loan = loanRows[0];
    console.log('=== loan_master row for case', LOANCASENO, '===');
    console.log(loan);

    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();

    // Full schedule including future installments — call the REAL private method.
    const fullSchedule = await (repaymentSvc as any).getInstallmentStatus(queryRunner, LOANCASENO, loan, TODAY, true);
    const dueOnlySchedule = await (repaymentSvc as any).getInstallmentStatus(queryRunner, LOANCASENO, loan, TODAY, false);
    await queryRunner.release();

    console.log('\n=== Installments actually due as of', TODAY.toDateString(), '(includeFuture=false) ===');
    console.log(dueOnlySchedule.length === 0 ? '(none — nothing due yet)' : dueOnlySchedule);

    console.log('\n=== Next upcoming EMI (installment #1 of full schedule) ===');
    const nextEmi = fullSchedule[0];
    console.log(nextEmi);

    console.log('\n=== calculateEarlyClosure(', LOANCASENO, ',', TODAY.toDateString(), ') — REAL public method ===');
    const closure = await repaymentSvc.calculateEarlyClosure(LOANCASENO, TODAY, 0, false);
    console.log(JSON.stringify(closure, null, 2));

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
