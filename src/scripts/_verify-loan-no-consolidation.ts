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

// Confirms ZERO consolidation happens when there's no ACTIVE existing loan of
// the same type — this member has old RLN loans (9999202, 9999191) but both
// are already at balance=0, so a brand-new RLN loan should behave exactly
// as disbursement did before this change: fully independent, no absorption.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MBNO = '900000002';
const NEW_CASE = '777900';
const LOAN_TYPE = 'RLN';
const LOAN_AMT = 40000;
const N = 15;
const APP_DATE = new Date(2027, 6, 27); // 27th -> Slot 1

async function main() {
    await AppDataSource.initialize();
    const sysConfig = new SystemConfigService(
        AppDataSource.getRepository(SystemConfig), AppDataSource.getRepository(InterestRate), AppDataSource.getRepository(DepositSlab),
    );
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const loanRepayment = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);
    const passSvc = new PassTransactionService(AppDataSource, sysConfig, loanEligibility, rdBalanceEvents, loanRepayment);

    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1 AND acc_type = $2`, [NEW_CASE, LOAN_TYPE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${NEW_CASE.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${NEW_CASE}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [NEW_CASE]);

    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'No-consolidation test','Y','N')`,
        [NEW_CASE, MBNO, LOAN_TYPE, LOAN_AMT, APP_DATE, N]
    );
    const voucherNo = `T${NEW_CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'No-consolidation verification',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, LOAN_AMT, MBNO, `LOAN_CASE:${NEW_CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1002',0)`,
        [transNo, MBNO, LOAN_AMT, voucherNo]
    );

    const passResult = await passSvc.passTransaction(voucherNo, 'no-consolidation-test');
    console.log('Pass Transaction result:', passResult);

    const newLoan = (await AppDataSource.query(`SELECT loan_amt, balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]))[0];
    console.log(`New case ${NEW_CASE}: loan_amt=${newLoan.loan_amt} (expect ${LOAN_AMT}), balance=${newLoan.balance} (expect ${LOAN_AMT})`);

    const pass1 = Math.abs(parseFloat(newLoan.loan_amt) - LOAN_AMT) < 0.01;
    const pass2 = Math.abs(parseFloat(newLoan.balance) - LOAN_AMT) < 0.01;
    console.log(`  ${pass1 ? 'PASS' : 'FAIL'} - loan_amt is just the new amount, nothing absorbed`);
    console.log(`  ${pass2 ? 'PASS' : 'FAIL'} - balance is just the new amount, nothing absorbed`);
    console.log((pass1 && pass2) ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');

    await AppDataSource.destroy();
    if (!pass1 || !pass2) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
