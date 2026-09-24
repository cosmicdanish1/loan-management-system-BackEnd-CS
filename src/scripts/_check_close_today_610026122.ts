import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Scenario: member walks in TODAY (19-Sep-2026) to close RLN 18234. Their
// September installment (#27) was already deducted by payroll in reality,
// but hasn't posted to our ledger yet (BSP lag, same direction problem as
// the payroll-lag credit feature, just on the CURRENT installment instead of
// a predecessor loan). We check the closure two ways: (A) as our ledger
// actually stands right now (Sept still shows as an unpaid/NR shortfall),
// and (B) with September's real payment recorded first, exactly as it would
// be if the DB were caught up to reality.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const CASE = '18234';
const MBNO = '900000122';

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBal = new RdBalanceEventsService(AppDataSource, rdRules);
    const elig = new LoanEligibilityService(AppDataSource, rdBal, rdRules);
    const svc = new LoanRepaymentService(AppDataSource, elig, rdBal);

    const today = new Date(); // real "today" per the system clock
    console.log('Today (system clock):', today.toDateString());

    console.log('\n=== (A) Closing TODAY, ledger as it currently stands (Sept not yet posted) ===');
    const qA = await svc.calculateEarlyClosure(CASE, today, 0, false);
    console.log(JSON.stringify(qA, null, 1));

    console.log('\n=== Recording the real September payment (₹20,833 + ₹5,521) as if BSP had posted it ===');
    const sept = await svc.recordLoanRepayment({
        mbno: MBNO, loancaseno: CASE, paymentAmount: 26354,
        receiptNo: 'SEPT-CHECK', narration: 'September installment (real payroll deduction, DB catch-up)',
        username: 'check-script', asOfDate: new Date(2026, 8, 15),
    });
    console.log('recordLoanRepayment result:', sept);

    console.log('\n=== (B) Closing TODAY, with September now recorded ===');
    const qB = await svc.calculateEarlyClosure(CASE, today, 0, false);
    console.log(JSON.stringify(qB, null, 1));

    // Roll back the test posting so the loan's real state (matching what's
    // shown to the user right now) is undisturbed.
    console.log('\n=== Rolling back the test September posting ===');
    await AppDataSource.query(
        `DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND receipt_no = 'SEPT-CHECK'`, [CASE]
    );
    await AppDataSource.query(
        `UPDATE loan_master SET balance = balance + 20833 WHERE loancaseno::text = $1`, [CASE]
    );
    console.log('Rolled back.');

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
