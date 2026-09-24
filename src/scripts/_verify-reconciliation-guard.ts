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

// Verifies the defensive reconciliation guard in PassTransactionService's
// consolidation branch: loan_master.balance vs member_balances.* must agree
// (within tolerance) before a same-type second loan is allowed to consolidate.
// Uses case 777900 (member 900000002, RLN, ₹40,000, zero repayments posted —
// loan_master.balance, loan_amt and member_balances.regularloan all already
// agree at 40000), the same clean fixture _verify-old-closure-interest.ts
// uses. case 777701 (the fixture the first version of this script used) has
// repayment history dated across 2026-2027 for unrelated report-demo
// purposes, so its ledger-derived outstanding legitimately disagrees with
// today's date — a real data quirk, not a bug in the guard being tested here.

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
const EXISTING_CASE = '777900';
const NEW_CASE = '777902';
const LOAN_TYPE = 'RLN';
const NEW_LOAN_AMT = 20000;
const N = 12;
const APP_DATE = new Date(2027, 6, 27); // 27th -> Slot 1
const EXISTING_BALANCE = 40000;

async function resetFixture(matchingMemberBalance: boolean) {
    await AppDataSource.query(
        `UPDATE loan_master SET balance = $2, consolidated_into_loancaseno = NULL WHERE loancaseno::text = $1`,
        [EXISTING_CASE, EXISTING_BALANCE]
    );
    await AppDataSource.query(
        `UPDATE member_balances SET regularloan = $2 WHERE mbno = $1`,
        [MBNO, matchingMemberBalance ? EXISTING_BALANCE : 10000]
    );
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND narration LIKE 'Consolidated into%'`, [EXISTING_CASE]);
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1 AND acc_type = $2`, [NEW_CASE, LOAN_TYPE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${NEW_CASE.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${NEW_CASE}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [NEW_CASE]);
}

async function stageAndDisburse(passSvc: PassTransactionService) {
    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'Reconciliation guard verification','Y','N')`,
        [NEW_CASE, MBNO, LOAN_TYPE, NEW_LOAN_AMT, APP_DATE, N]
    );
    const voucherNo = `T${NEW_CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Reconciliation guard verification',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, NEW_LOAN_AMT, MBNO, `LOAN_CASE:${NEW_CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1002',0)`,
        [transNo, MBNO, NEW_LOAN_AMT, voucherNo]
    );
    return passSvc.passTransaction(voucherNo, 'reconciliation-guard-test');
}

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

    let allPass = true;

    console.log('=== TEST 1: mismatched balances (loan_master vs member_balances) — must BLOCK ===');
    await resetFixture(false);
    try {
        await stageAndDisburse(passSvc);
        console.log('FAIL - expected passTransaction to throw, but it succeeded');
        allPass = false;
    } catch (e: any) {
        const blocked = /Loan consolidation blocked/.test(e.message);
        console.log(`${blocked ? 'PASS' : 'FAIL'} - threw: ${e.message}`);
        if (!blocked) allPass = false;
    }
    const oldAfterBlock = (await AppDataSource.query(`SELECT balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1`, [EXISTING_CASE]))[0];
    const noNewCase = (await AppDataSource.query(`SELECT count(*) as c FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]))[0];
    console.log(`  old case balance unchanged: ${parseFloat(oldAfterBlock.balance) === EXISTING_BALANCE} (balance=${oldAfterBlock.balance}), consolidated_into=${oldAfterBlock.consolidated_into_loancaseno} (expect null)`);
    console.log(`  no new case was created: ${noNewCase.c === '0'} (count=${noNewCase.c})`);
    if (parseFloat(oldAfterBlock.balance) !== EXISTING_BALANCE || oldAfterBlock.consolidated_into_loancaseno !== null || noNewCase.c !== '0') allPass = false;

    console.log('\n=== TEST 2: matching balances — must SUCCEED (pre-existing behaviour preserved) ===');
    await resetFixture(true);
    try {
        const result = await stageAndDisburse(passSvc);
        console.log(`PASS - passTransaction succeeded: ${JSON.stringify(result)}`);
    } catch (e: any) {
        console.log(`FAIL - expected success, but threw: ${e.message}`);
        allPass = false;
    }
    const oldAfterOk = (await AppDataSource.query(`SELECT balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1`, [EXISTING_CASE]))[0];
    const newAfterOk = (await AppDataSource.query(`SELECT loan_amt, balance FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]))[0];
    const expectedCombined = EXISTING_BALANCE + NEW_LOAN_AMT;
    console.log(`  old case zeroed: ${parseFloat(oldAfterOk.balance) === 0} (balance=${oldAfterOk.balance}), consolidated_into=${oldAfterOk.consolidated_into_loancaseno} (expect ${NEW_CASE})`);
    console.log(`  new case combined balance: ${newAfterOk?.balance} (expect ${expectedCombined.toFixed(2)})`);
    if (parseFloat(oldAfterOk.balance) !== 0 || String(oldAfterOk.consolidated_into_loancaseno) !== NEW_CASE
        || !newAfterOk || Math.abs(parseFloat(newAfterOk.balance) - expectedCombined) > 0.01) allPass = false;

    // Leave the fixture in the same reusable, reconciled state
    // _verify-old-closure-interest.ts also expects for its own next run.
    await resetFixture(true);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]);

    console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
    await AppDataSource.destroy();
    if (!allPass) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
