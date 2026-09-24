import { DataSource } from 'typeorm';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { SystemConfigService } from '../modules/admin/services/system-config.service';
import { SystemConfig } from '../modules/admin/entities/system-config.entity';
import { InterestRate } from '../modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../modules/admin/entities/deposit-slab.entity';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Verifies the new loan-consolidation logic against a REAL existing loan
// (case 777701, member 900000002, created by _create-demo-loan-for-reports.ts,
// already 10 real EMI payments in, balance ~176,951.89) by disbursing a
// brand-new ALN loan for the SAME member and confirming it correctly absorbs
// the existing balance instead of becoming an independent second loan.

const AppDataSource = new DataSource({
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'EMP_Espat_Society',
    username: 'postgres',
    password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    synchronize: false,
    logging: false,
});

const MBNO = '900000002';
const EXISTING_CASE = '777701';
const NEW_CASE = '777801';
const LOAN_TYPE = 'ALN';
const NEW_LOAN_AMT = 50000;
const N = 20;
const APP_DATE = new Date(2027, 5, 27); // 27th -> Slot 1

async function main() {
    await AppDataSource.initialize();
    const sysConfig = new SystemConfigService(
        AppDataSource.getRepository(SystemConfig),
        AppDataSource.getRepository(InterestRate),
        AppDataSource.getRepository(DepositSlab),
    );
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const loanRepayment = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);
    const passSvc = new PassTransactionService(AppDataSource, sysConfig, loanEligibility, rdBalanceEvents, loanRepayment);

    console.log('=== BEFORE ===');
    const before = (await AppDataSource.query(`SELECT loancaseno, balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1`, [EXISTING_CASE]))[0];
    console.log(`Existing case ${EXISTING_CASE}: balance=${before.balance}, consolidated_into=${before.consolidated_into_loancaseno}`);
    const beforeMb = (await AppDataSource.query(`SELECT COALESCE(emergency_loan_balance,0) as v FROM member_balances WHERE mbno = $1`, [MBNO]))[0];
    const beforeMbVal = parseFloat(beforeMb?.v || 0);
    console.log(`member_balances.emergency_loan_balance before: ${beforeMbVal}`);
    const existingBalance = parseFloat(before.balance);

    // Clean up any leftover rows from a prior run of this script only.
    // BUG FIX: this used to filter on NEW_CASE, but the consolidation-closure
    // row is inserted on the OLD case (EXISTING_CASE) being absorbed — the
    // original filter never matched anything, so every prior run's "merge
    // ledger row" accumulated on 777701 instead of being cleaned up (found
    // while verifying oldClosureInterest; two stale ₹176,951.89 phantom rows
    // had polluted totalPrincipalPaid enough to make outstandingPrincipal
    // negative).
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND narration LIKE 'Consolidated into%'`, [EXISTING_CASE]);
    await AppDataSource.query(`UPDATE loan_master SET balance = $2, consolidated_into_loancaseno = NULL WHERE loancaseno::text = $1 AND consolidated_into_loancaseno::text = $3`, [EXISTING_CASE, existingBalance, NEW_CASE]);
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1 AND acc_type = $2`, [NEW_CASE, LOAN_TYPE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${NEW_CASE.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${NEW_CASE}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [NEW_CASE]);

    // Stage and disburse the new loan through the REAL flow.
    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'Consolidation verification - second ALN loan','Y','N')`,
        [NEW_CASE, MBNO, LOAN_TYPE, NEW_LOAN_AMT, APP_DATE, N]
    );
    const voucherNo = `T${NEW_CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Consolidation verification',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, NEW_LOAN_AMT, MBNO, `LOAN_CASE:${NEW_CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1047',0)`,
        [transNo, MBNO, NEW_LOAN_AMT, voucherNo]
    );

    console.log('\n=== DISBURSING NEW LOAN (should trigger consolidation) ===');
    const passResult = await passSvc.passTransaction(voucherNo, 'consolidation-test');
    console.log('Pass Transaction result:', passResult);

    console.log('\n=== AFTER ===');
    const oldAfter = (await AppDataSource.query(`SELECT balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1`, [EXISTING_CASE]))[0];
    const newAfter = (await AppDataSource.query(`SELECT loan_amt, balance, instal_amt, no_of_instal FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]))[0];
    const rbCount = (await AppDataSource.query(`SELECT COUNT(*) as c FROM loan_rb_schedule WHERE loancaseno::text = $1`, [NEW_CASE]))[0].c;
    const mergeLedgerRow = (await AppDataSource.query(`SELECT principal_amount, narration FROM loan_repayment_ledger WHERE loancaseno = $1 AND narration LIKE 'Consolidated%'`, [EXISTING_CASE]))[0];
    const afterMb = (await AppDataSource.query(`SELECT COALESCE(emergency_loan_balance,0) as v FROM member_balances WHERE mbno = $1`, [MBNO]))[0];
    const afterMbVal = parseFloat(afterMb?.v || 0);

    console.log(`Old case ${EXISTING_CASE}: balance=${oldAfter.balance} (expect 0), consolidated_into=${oldAfter.consolidated_into_loancaseno} (expect ${NEW_CASE})`);
    console.log(`New case ${NEW_CASE}: loan_amt=${newAfter.loan_amt}, balance=${newAfter.balance} (expect ${(existingBalance + NEW_LOAN_AMT).toFixed(2)})`);
    console.log(`New case instal_amt=${newAfter.instal_amt}, no_of_instal=${newAfter.no_of_instal}`);
    console.log(`loan_rb_schedule rows for new case: ${rbCount} (expect ${N})`);
    console.log(`Merge ledger row on old case: principal_amount=${mergeLedgerRow?.principal_amount}, narration="${mergeLedgerRow?.narration}"`);
    console.log(`member_balances.emergency_loan_balance: before=${beforeMbVal}, after=${afterMbVal}, delta=${(afterMbVal - beforeMbVal).toFixed(2)} (expect ${NEW_LOAN_AMT})`);

    console.log('\n=== PASS/FAIL CHECKS ===');
    const checks: [string, boolean][] = [
        ['Old case balance zeroed', parseFloat(oldAfter.balance) === 0],
        ['Old case links to new case', String(oldAfter.consolidated_into_loancaseno) === NEW_CASE],
        ['New case combines both balances', Math.abs(parseFloat(newAfter.balance) - (existingBalance + NEW_LOAN_AMT)) < 0.01],
        ['New case loan_amt matches combined', Math.abs(parseFloat(newAfter.loan_amt) - (existingBalance + NEW_LOAN_AMT)) < 0.01],
        ['RB schedule built for new (combined) case', parseInt(rbCount) === N],
        ['Merge ledger row documents old balance', mergeLedgerRow && Math.abs(parseFloat(mergeLedgerRow.principal_amount) - existingBalance) < 0.01],
        ['member_balances incremented by new amount only (not combined)', Math.abs((afterMbVal - beforeMbVal) - NEW_LOAN_AMT) < 0.01],
    ];
    let allPass = true;
    for (const [label, pass] of checks) {
        console.log(`  ${pass ? 'PASS' : 'FAIL'} - ${label}`);
        if (!pass) allPass = false;
    }
    console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');

    await AppDataSource.destroy();
    if (!allPass) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
