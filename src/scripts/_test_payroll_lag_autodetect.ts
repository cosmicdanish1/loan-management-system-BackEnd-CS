import { DataSource } from 'typeorm';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { SystemConfigService } from '../modules/admin/services/system-config.service';
import { SystemConfig } from '../modules/admin/entities/system-config.entity';
import { InterestRate } from '../modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../modules/admin/entities/deposit-slab.entity';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// End-to-end test of the NEW automatic payroll-lag detection feature, on a
// fresh synthetic member — proves the feature works going forward, not just
// on hand-patched historical data. Steps:
//   1. Disburse an "old" ALN loan (simulates a loan already in progress).
//   2. Disburse a SECOND ALN loan for the same member -> passTransaction's
//      existing consolidation logic merges them, and (with this session's
//      change) arms the payroll-lag watch automatically.
//   3. Post a real repayment via recordLoanRepayment() for exactly the OLD
//      loan's EMI amount, within the watch window -> should be auto-detected
//      and flagged, NOT pooled into the new loan's schedule.
//   4. Post a real repayment for the NEW loan's own EMI amount -> should be
//      pooled normally, proving detection doesn't misfire on genuine payments.
//   5. Call calculateEarlyClosure() -> suggestedAdjustment should reflect the
//      credit, DETECTED but not folded into finalClosureAmount (per the
//      user's explicit decision: suggest-only, operator must accept it).

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MBNO = '900000999';
const OLD_CASE = '99901';
const NEW_CASE = '99902';

async function disburse(passSvc: PassTransactionService, caseNo: string, amt: number, n: number) {
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [caseNo]);
    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,'ALN',$3,$3,NOW(),NOW(),$4,'Autodetect test','Y','N')`,
        [caseNo, MBNO, amt, n]
    );
    const voucherNo = `T${caseNo}`;
    await AppDataSource.query(`DELETE FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [voucherNo]);
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Autodetect test',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, amt, MBNO, `LOAN_CASE:${caseNo}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Disbursement (autodetect test)','A1047',0)`,
        [transNo, MBNO, amt, voucherNo]
    );
    return passSvc.passTransaction(voucherNo, 'autodetect-test');
}

async function main() {
    await AppDataSource.initialize();
    const sysConfig = new SystemConfigService(
        AppDataSource.getRepository(SystemConfig), AppDataSource.getRepository(InterestRate), AppDataSource.getRepository(DepositSlab),
    );
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
        const repaymentSvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);
    const passSvc = new PassTransactionService(AppDataSource, sysConfig, loanEligibility, rdBalanceEvents, repaymentSvc);

    console.log(`=== Payroll-lag auto-detection test, synthetic mbno ${MBNO} ===\n`);

    // clean slate
    for (const t of ['loan_rb_schedule', 'loan_repayment_ledger', 'loan_master', 'loan_pending', 'member_balances', 'ledger']) {
        await AppDataSource.query(`DELETE FROM ${t} WHERE mbno::text = $1`, [MBNO]);
    }
    for (const c of [OLD_CASE, NEW_CASE]) {
        await AppDataSource.query(`DELETE FROM vouchers WHERE "voucherNumber" = $1`, [`T${c}`]);
        await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${c}`]);
    }

    console.log('1. Disbursing OLD loan (case', OLD_CASE, ', Rs.1,00,000, 20 installments)...');
    await disburse(passSvc, OLD_CASE, 100000, 20);
    const oldLoan = (await AppDataSource.query(
        `SELECT loan_amt, no_of_instal, instal_amt, balance FROM loan_master WHERE loancaseno::text = $1`, [OLD_CASE]
    ))[0];
    const oldMp = 100000 / 20;
    const oldMi = parseFloat(oldLoan.instal_amt) - oldMp;
    console.log(`   Old loan EMI: principal Rs.${oldMp}, interest Rs.${oldMi.toFixed(2)} (instal_amt Rs.${oldLoan.instal_amt})\n`);

    console.log('2. Disbursing NEW loan (case', NEW_CASE, ', Rs.50,000) -- should consolidate the old one and arm the watch...');
    await disburse(passSvc, NEW_CASE, 50000, 20);
    const newLoan = (await AppDataSource.query(
        `SELECT loan_amt, no_of_instal, instal_amt, balance, delay_months, payroll_lag_watch_until, payroll_lag_old_principal, payroll_lag_old_interest
         FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]
    ))[0];
    console.log('   New (consolidated) loan_master row:', newLoan);
    const oldStatus = (await AppDataSource.query(
        `SELECT balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1`, [OLD_CASE]
    ))[0];
    console.log('   Old case status after consolidation:', oldStatus, '\n');

    // Correct payment_date back to a real disbursement date so the schedule isn't anchored to "today"
    const disbDate = new Date(2026, 6, 1); // 01-Jul-2026
    await AppDataSource.query(`UPDATE loan_master SET payment_date = $1 WHERE loancaseno::text = $2`, [disbDate, NEW_CASE]);

    const strayAmount = Math.round((oldMp + oldMi) * 100) / 100;
    console.log(`3. Posting a real recordLoanRepayment() for Rs.${strayAmount} (matches OLD loan's EMI exactly) `
        + `on ${new Date(2026, 6, 20).toDateString()} — should be auto-detected...`);
    const r1 = await repaymentSvc.recordLoanRepayment({
        mbno: MBNO, loancaseno: NEW_CASE, paymentAmount: strayAmount,
        receiptNo: 'AUTO-TEST-1', narration: 'stray old-rate payment', username: 'autodetect-test',
        asOfDate: new Date(2026, 6, 20),
    });
    console.log('   Result:', r1, '\n');

    const newMp = 150000 / 20; // consolidated principal 100000+50000=150000, n=20
    console.log(`4. Posting a real recordLoanRepayment() for the NEW loan's own EMI (Rs.${newMp} + interest) on 01-Sep-2026 — should pool normally...`);
    const newInstalAmt = parseFloat(newLoan.instal_amt);
    const newMi = Math.round((newInstalAmt - newMp) * 100) / 100;
    const r2 = await repaymentSvc.recordLoanRepayment({
        mbno: MBNO, loancaseno: NEW_CASE, paymentAmount: Math.round((newMp + newMi) * 100) / 100,
        receiptNo: 'AUTO-TEST-2', narration: 'genuine new-rate installment', username: 'autodetect-test',
        asOfDate: new Date(2026, 7, 1),
    });
    console.log('   Result:', r2, '\n');

    console.log('5. Ledger rows for the new case:');
    const ledgerRows = await AppDataSource.query(
        `SELECT payment_date, principal_amount, interest_amount, is_payroll_lag_credit, narration
         FROM loan_repayment_ledger WHERE loancaseno::text = $1 ORDER BY payment_date`, [NEW_CASE]
    );
    console.log(ledgerRows);

    console.log('\n6. calculateEarlyClosure(adjustment=0) — suggestedAdjustment should reflect the credit (detected, NOT auto-applied):');
    const closure = await repaymentSvc.calculateEarlyClosure(NEW_CASE, new Date(2026, 8, 5), 0, false);
    console.log(`   outstandingPrincipal=${closure.outstandingPrincipal} suggestedAdjustment=${closure.suggestedAdjustment} `
        + `finalClosureAmount=${closure.finalClosureAmount} (should NOT include the credit)`);
    console.log(`   paidInstallments=${closure.paidInstallments} (should be 1 -- only the genuine new-rate payment counts)`);

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
