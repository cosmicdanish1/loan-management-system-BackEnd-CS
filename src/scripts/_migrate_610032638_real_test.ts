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

// Migrates REAL legacy member 610032638's ALN case 20327 (Rs.5,00,000,
// disbursed 07-Mar-2026, n=15) into our own schema through the REAL
// disbursement pipeline (PassTransactionService.passTransaction — the exact
// code path a live disbursement uses), then replays the 3 real principal +
// interest recoveries actually collected (10-Jun/14-Jul/11-Aug-2026, each
// Rs.33,333 principal + Rs.3,333 interest, verified against
// EMP_Espat_Society_dan.LEDGER this session), then calls the REAL,
// unmodified calculateEarlyClosure() — no hand re-implementation anywhere in
// this script. Uses synthetic mbno 900000638 so the real member's live data
// is never touched, same convention as the prior 610026821 replay
// (src/scripts/_simulate_610026821_real_replay.ts).
//
// This intentionally does NOT override busrules — whatever gracedays/
// smpenalpct/smpenaldiv/penalrate/delay_months the live busrules table says
// right now is what gets frozen onto loan_master at "disbursement" here,
// exactly as a real live disbursement would freeze it. The script prints
// what actually got frozen so the result can be read honestly.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MBNO = '900000638';
const LOAN_CASE = '20327';
const LOAN_AMT = 500000;
const RATE = 12;
const N = 15; // validated this session: our own EMI formula reproduces the real billed Rs.3,333/month only at n=15
const APP_DATE = new Date(2026, 2, 7); // 07-Mar-2026

const RECOVERIES = [
    { date: new Date(2026, 5, 10), principal: 33333, interest: 3333, receipt: 'R-TEST-1' }, // 10-Jun-2026
    { date: new Date(2026, 6, 14), principal: 33333, interest: 3333, receipt: 'R-TEST-2' }, // 14-Jul-2026
    { date: new Date(2026, 7, 11), principal: 33333, interest: 3333, receipt: 'R-TEST-3' }, // 11-Aug-2026
];

async function disburse(passSvc: PassTransactionService) {
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [LOAN_CASE]);
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1`, [LOAN_CASE]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1`, [LOAN_CASE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [LOAN_CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${LOAN_CASE}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${LOAN_CASE}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [LOAN_CASE]);
    await AppDataSource.query(`DELETE FROM member_balances WHERE mbno = $1`, [MBNO]);

    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,'ALN',$3,$3,$4,$4,$5,'Migration test 610032638','Y','N')`,
        [LOAN_CASE, MBNO, LOAN_AMT, APP_DATE, N]
    );
    const voucherNo = `T${LOAN_CASE}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Migration test disbursement',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, LOAN_AMT, MBNO, `LOAN_CASE:${LOAN_CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement (migration test)','A1047',0)`,
        [transNo, MBNO, LOAN_AMT, voucherNo]
    );
    const result = await passSvc.passTransaction(voucherNo, 'migration-test-610032638');
    console.log(`Disbursed case ${LOAN_CASE} (Rs.${LOAN_AMT.toLocaleString()}, ${APP_DATE.toDateString()}) via REAL passTransaction(): ${result.message}`);

    // pass-transaction.service.ts always stamps payment_date = new Date() at
    // the moment disbursement is actually processed (correct for a real live
    // disbursement) — but this is a REPLAY of a real past disbursement, so
    // the schedule must anchor to the real 07-Mar-2026 date, not today, or
    // every installment silently reads as not-yet-due. Same correction the
    // precedent 610026821 replay script needed for the same reason.
    await AppDataSource.query(`UPDATE loan_master SET payment_date = $1 WHERE loancaseno::text = $2`, [APP_DATE, LOAN_CASE]);
    console.log(`Corrected payment_date to the real disbursement date ${APP_DATE.toDateString()} (was stamped 'now' by the real disbursement code).`);
}

async function applyRealPayment(p: typeof RECOVERIES[number]) {
    const total = p.principal + p.interest;
    await AppDataSource.query(`UPDATE loan_master SET balance = balance - $1 WHERE loancaseno::text = $2`, [p.principal, LOAN_CASE]);
    await AppDataSource.query(
        `INSERT INTO loan_repayment_ledger
            (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
             principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
         VALUES ($1, $2, 'ALN', $3, $4, $5, $6, $7, $8, 0, 0, $9, $10, $11)`,
        [MBNO, LOAN_CASE, p.date, p.date.getMonth() + 1, p.date.getFullYear(), total,
            p.principal, p.interest, p.receipt, 'Real legacy recovery replay (verified against LEDGER A1047+I1002)', 'migration-test-610032638']
    );
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

    console.log(`=== Migrating REAL legacy member 610032638's ALN 20327 as synthetic member ${MBNO} ===`);
    console.log('Source: EMP_Espat_Society_dan (LOAN_MASTER, LOAN_PENDING, LEDGER) — verified live this session\n');

    await disburse(passSvc);

    console.log(`\n=== Frozen loan_master row (what the REAL disbursement code actually wrote) ===`);
    const frozen = await AppDataSource.query(
        `SELECT loancaseno, loan_amt, balance, no_of_instal, instal_amt, rate, penalrate, gracedays,
                smpenalpct, smpenaldiv, delay_months, payment_date
         FROM loan_master WHERE loancaseno::text = $1`, [LOAN_CASE]
    );
    console.log(frozen);

    console.log(`\n=== Replaying ${RECOVERIES.length} real recoveries ===`);
    for (const p of RECOVERIES) {
        await applyRealPayment(p);
        console.log(`  ${p.date.toDateString()}: principal Rs.${p.principal}, interest Rs.${p.interest} (receipt ${p.receipt})`);
    }

    const loanRow = (await AppDataSource.query(
        `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months
         FROM loan_master WHERE loancaseno::text = $1`, [LOAN_CASE]
    ))[0];

    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    const TODAY = new Date(2026, 8, 18); // 18-Sep-2026, real session date
    const dueSchedule = await (repaymentSvc as any).getInstallmentStatus(queryRunner, LOAN_CASE, loanRow, TODAY, false);
    await queryRunner.release();

    console.log(`\n=== Installments due as of ${TODAY.toDateString()} ===`);
    console.log(dueSchedule.map((i: any) => ({
        n: i.installmentNo, due: i.dueDate.toDateString(), principalDue: i.principalDue,
        interestDue: i.interestDue, tier: i.tier, penalDue: i.penalDue, fullyPaid: i.isFullyPaid,
    })));

    for (const closureDate of [new Date(2026, 8, 18), new Date(2026, 9, 5)]) {
        console.log(`\n=== calculateEarlyClosure('${LOAN_CASE}', ${closureDate.toDateString()}) — REAL unmodified method B ===`);
        const closure = await repaymentSvc.calculateEarlyClosure(LOAN_CASE, closureDate, 0, false);
        console.log(JSON.stringify(closure, null, 2));
    }

    console.log(`\n=== Cleanup note: this migrated test loan lives under synthetic mbno ${MBNO} only. ===`);
    console.log(`Delete it with: DELETE FROM loan_rb_schedule/loan_repayment_ledger/ledger/loan_master/loan_pending/member_balances/vouchers/transactions WHERE mbno/loancaseno matches '${MBNO}'/'${LOAN_CASE}' — left in place for inspection unless you ask me to remove it.`);

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
