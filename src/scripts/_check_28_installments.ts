import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Verifies the employee's manual figures (28 EMIs paid, no NR, Rs.4,16,676
// remaining, Rs.66,669.1 closure interest) against the real code. My first
// test posted a single lump payment dated 15-Sep-2026 -- BEFORE installment
// #28's due month (October) had started -- so getInstallmentStatus correctly
// treated the leftover as a proportional future-prepayment split (per BUG
// FIX 40's documented behaviour), not a clean second installment. That
// produced a fragmented, non-round result. Here #27's exact shortfall and
// #28's exact EMI are posted as two SEPARATE clean payments, both dated on
// or after installment #28 is genuinely due, to see if that reproduces the
// employee's numbers.

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

    // Clear #27's exact Rs.9 shortfall first (dated within September, before #28 is due)
    const r1 = await svc.recordLoanRepayment({
        mbno: MBNO, loancaseno: CASE, paymentAmount: 9,
        receiptNo: 'CHK-1', narration: 'clear #27 shortfall', username: 'check-script',
        asOfDate: new Date(2026, 8, 15),
    });
    console.log('Step 1 (clear #27 shortfall):', r1);

    // Now post #28's own full EMI, dated on/after its due month (Oct) has started,
    // so it's recognised as a real due installment, not a future prepayment.
    const r2 = await svc.recordLoanRepayment({
        mbno: MBNO, loancaseno: CASE, paymentAmount: 26354,
        receiptNo: 'CHK-2', narration: 'installment #28 own EMI', username: 'check-script',
        asOfDate: new Date(2026, 9, 5),
    });
    console.log('Step 2 (installment #28, asOf 05-Oct-2026):', r2);

    console.log('\n=== calculateEarlyClosure(05-Oct-2026) with both cleanly posted ===');
    const q = await svc.calculateEarlyClosure(CASE, new Date(2026, 9, 5), 0, false);
    console.log(JSON.stringify(q, null, 1));

    console.log('\n=== Rolling back both test postings ===');
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND receipt_no IN ('CHK-1','CHK-2')`, [CASE]);
    await AppDataSource.query(`UPDATE loan_master SET balance = balance + 20833 WHERE loancaseno::text = $1`, [CASE]);
    console.log('Rolled back.');

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
