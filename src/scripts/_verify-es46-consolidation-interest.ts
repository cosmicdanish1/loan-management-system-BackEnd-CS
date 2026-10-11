import 'dotenv/config';
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

// ES-46: verifies consolidation closure interest posts to the per-loan-type child head
// (I1013 for RLN) instead of the I1002 parent. Uses SLOTMATRIX member 9999962386 / case 889053.
// Self-cleaning: snapshots the old loan + member_balances first and restores them after.

const AppDataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: 5432,
    database: 'EMP_Espat_Society',
    username: 'postgres',
    password: process.env.DB_PASSWORD,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    synchronize: false,
    logging: false,
});

const MBNO = '9999962386';
const EXISTING_CASE = '889053';
const NEW_CASE = '889999';
const LOAN_TYPE = 'RLN';
const NEW_LOAN_AMT = 20000;
const N = 12;
const APP_DATE = new Date(2027, 6, 27);
const VOUCHER = `T${NEW_CASE.slice(-5)}`;

let snapLoan: any;
let snapBal: any;
let startedAt: Date;
let ledgerBefore = 0;

const q = (s: string, p: any[] = []) => AppDataSource.query(s, p);

async function cleanup() {
    await q(`DELETE FROM ledger WHERE acc_no::text = $1 OR receipt_vchr_no = $2`, [NEW_CASE, VOUCHER]);
    await q(`DELETE FROM tblcashbook WHERE trans_date >= $1 AND headcode IN ('A1002','L1001','L1004','I1013','I1002','I1014')`, [startedAt]);
    await q(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [NEW_CASE]);
    await q(`DELETE FROM loan_schedule_versions WHERE loancaseno::text = $1`, [NEW_CASE]);
    await q(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND narration LIKE 'Consolidated into%'`, [EXISTING_CASE]);
    await q(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]);
    await q(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [VOUCHER]);
    await q(`DELETE FROM vouchers WHERE "voucherNumber" = $1`, [VOUCHER]);
    await q(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [NEW_CASE]);
    if (snapLoan) {
        await q(`UPDATE loan_master SET balance = $1, consolidated_into_loancaseno = $2 WHERE loancaseno::text = $3`,
            [snapLoan.balance, snapLoan.consolidated_into_loancaseno, EXISTING_CASE]);
    }
    if (snapBal) {
        await q(`UPDATE member_balances SET regularloan = $1, shares = $2 WHERE mbno::text = $3`,
            [snapBal.regularloan, snapBal.shares, MBNO]);
    }
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

    snapLoan = (await q(`SELECT balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1`, [EXISTING_CASE]))[0];
    snapBal = (await q(`SELECT regularloan, shares FROM member_balances WHERE mbno::text = $1`, [MBNO]))[0];
    ledgerBefore = parseInt((await q(`SELECT count(*) c FROM ledger WHERE mbno::text = $1`, [MBNO]))[0].c, 10);
    startedAt = new Date();
    console.log('snapshot', snapLoan, snapBal, 'ledger rows before', ledgerBefore);

    let allPass = true;
    const check = (label: string, pass: boolean) => { console.log(`  ${pass ? 'PASS' : 'FAIL'} - ${label}`); if (!pass) allPass = false; };
    try {
        const quote = await loanRepayment.calculateEarlyClosure(EXISTING_CASE, new Date(), 0, false, MBNO);
        const expected = Math.round((quote.nrInterest + quote.apInterest + quote.penalInterest) * 100) / 100;
        console.log('expected old closure interest', expected);

        await q(`INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
                 VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'ES-46 verification','Y','N')`, [NEW_CASE, MBNO, LOAN_TYPE, NEW_LOAN_AMT, APP_DATE, N]);
        const maxId = (await q(`SELECT COALESCE(MAX(id),0)+1 n FROM vouchers`))[0].n;
        await q(`INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
                 VALUES ($1,$2,NOW(),'PAYMENT',$3,'ES-46 verification',$4,'PENDING',$5,NOW())`,
            [maxId, VOUCHER, NEW_LOAN_AMT, MBNO, `LOAN_CASE:${NEW_CASE}|PAY_MODE:CASH`]);
        const transNo = (await q(`SELECT COALESCE(MAX(trans_no),0)+1 n FROM transactions`))[0].n;
        await q(`INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
                 VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1002',0)`, [transNo, MBNO, NEW_LOAN_AMT, VOUCHER]);

        const result = await passSvc.passTransaction(VOUCHER, 'es46-test');
        console.log('pass result', JSON.stringify(result).slice(0, 200));

        const rows = await q(`SELECT code, trans_type, trans_amt FROM ledger WHERE receipt_vchr_no = $1 AND code LIKE 'I1%' ORDER BY ledgerid`, [VOUCHER]);
        console.log('interest-head ledger rows for this voucher:', rows);
        check('expected closure interest > 0', expected > 0);
        check('closure interest posted to I1013 (Regular-loan child head)',
            rows.some((r: any) => r.code === 'I1013' && Math.abs(parseFloat(r.trans_amt) - expected) < 0.01));
        check('nothing posted to the I1002 parent or the Emergency head I1014',
            !rows.some((r: any) => r.code === 'I1002' || r.code === 'I1014'));
    } finally {
        await cleanup();
        const after = parseInt((await q(`SELECT count(*) c FROM ledger WHERE mbno::text = $1`, [MBNO]))[0].c, 10);
        const restored = (await q(`SELECT balance FROM loan_master WHERE loancaseno::text = $1`, [EXISTING_CASE]))[0];
        console.log(`cleanup: ledger rows ${ledgerBefore} -> ${after}; old loan balance restored to ${restored?.balance}`);
        check('cleanup restored the member to the exact starting state',
            after === ledgerBefore && Math.abs(parseFloat(restored.balance) - parseFloat(snapLoan.balance)) < 0.001);
    }
    console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
    await AppDataSource.destroy();
    if (!allPass) process.exit(1);
}
main().catch(async (e) => { console.error(e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
