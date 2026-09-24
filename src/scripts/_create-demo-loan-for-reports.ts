import { DataSource } from 'typeorm';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { SystemConfigService } from '../modules/admin/services/system-config.service';
import { SystemConfig } from '../modules/admin/entities/system-config.entity';
import { InterestRate } from '../modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../modules/admin/entities/deposit-slab.entity';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Creates ONE real, persisted demo loan through the actual live disbursement
// path (loan_pending -> staged voucher -> PassTransactionService), then
// records 10 real on-time EMI payments through the actual repayment path --
// so it shows up correctly in every report screen exactly as a real loan
// would. Nothing is deleted afterward.

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
const CASE = '777701';
const LOAN_AMT = 300000;
const N = 30;
const LOAN_TYPE = 'ALN';
const APP_DATE = new Date(2027, 2, 25); // March 25, 2027 -> Slot 1 (25th-5th window)

function d(y: number, m: number, day: number) { return new Date(y, m - 1, day); }

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
    const repaySvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);
    const passSvc = new PassTransactionService(AppDataSource, sysConfig, loanEligibility, rdBalanceEvents, repaySvc);

    // Clear this exact case number only, in case of a re-run.
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [CASE]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1 AND acc_type = $2`, [CASE, LOAN_TYPE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${CASE.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${CASE}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [CASE]);

    // 1. Application (loan_pending) -- sanctioned and ready for disbursement
    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'Demo loan for report verification','Y','N')`,
        [CASE, MBNO, LOAN_TYPE, LOAN_AMT, APP_DATE, N]
    );
    console.log(`Loan case ${CASE} created in loan_pending, app_date=${APP_DATE.toDateString()} (Slot 1)`);

    // 2. Stage the disbursement voucher (mirrors what the Loan Sanction/Disbursement screen does)
    const voucherNo = `T${CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Demo loan disbursement for report verification',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, LOAN_AMT, MBNO, `LOAN_CASE:${CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1047',0)`,
        [transNo, MBNO, LOAN_AMT, voucherNo]
    );
    console.log(`Voucher ${voucherNo} staged (PENDING)`);

    // 3. Pass the transaction -- this is the REAL disbursement activation path,
    // computes the RB schedule + slot + constant EMI, creates loan_master.
    const passResult = await passSvc.passTransaction(voucherNo, 'demo-setup');
    console.log('Pass Transaction result:', passResult);

    const loanRow = (await AppDataSource.query(`SELECT * FROM loan_master WHERE loancaseno::text = $1`, [CASE]))[0];
    console.log('\nloan_master row:', {
        loancaseno: loanRow.loancaseno, loantype: loanRow.loantype, loan_amt: loanRow.loan_amt,
        rate: loanRow.rate, no_of_instal: loanRow.no_of_instal, instal_amt: loanRow.instal_amt,
        intt_amount: loanRow.intt_amount, balance: loanRow.balance, payment_date: loanRow.payment_date,
    });

    const instalAmt = parseFloat(loanRow.instal_amt);
    const disb = new Date(loanRow.payment_date);

    // 4. Record 10 real on-time EMI payments through the actual repayment path.
    for (let m = 1; m <= 10; m++) {
        const dd = new Date(disb); dd.setMonth(dd.getMonth() + m); dd.setDate(10);
        const r = await repaySvc.recordLoanRepayment({
            mbno: MBNO, loancaseno: CASE, paymentAmount: instalAmt, asOfDate: dd,
            narration: `EMI ${m} - demo loan`, username: 'demo-setup', receiptNo: `DEMO-R${m}`,
        } as any);
        console.log(`  Month ${m} (${dd.toDateString()}): ${r.message}`);
    }

    const finalBalance = (await AppDataSource.query(`SELECT balance FROM loan_master WHERE loancaseno::text = $1`, [CASE]))[0].balance;
    const rbCount = (await AppDataSource.query(`SELECT COUNT(*) as c FROM loan_rb_schedule WHERE loancaseno::text = $1`, [CASE]))[0].c;
    console.log(`\nFinal state: balance=₹${finalBalance}, loan_rb_schedule rows=${rbCount}`);
    console.log(`\nDemo loan ${CASE} for member ${MBNO} (Kavita Gupta) is LIVE in the database. Not cleaned up.`);

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
