import * as fs from 'fs';
import * as path from 'path';
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

// Faithful replay of REAL legacy member 610026821's entire real ALN loan +
// principal-repayment history (pulled fresh from the live legacy MS SQL DB,
// docs/legacy_extract/member_610026821_aln_full.json — 6 real disbursements,
// 81 real ledger rows, zero hand-typed figures) through our OWN fixed
// consolidation code, using synthetic mbno 900000601 so the real member's
// live data is never touched. This reproduces this member's REAL current
// combined position (Rs.2,26,500 as of the last real payment, 13-Apr-2026)
// genuinely inside our schema, so calculateEarlyClosure()/getInstallmentStatus()
// — our own real functions — can be called on it for "next EMI" and "early
// closure today" with zero guessed numbers.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MBNO = '900000601';
const TODAY = new Date(2026, 8, 17); // 17-Sep-2026, real session date

const dataPath = path.join(__dirname, '../../../docs/legacy_extract/member_610026821_aln_full.json');
const real = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

interface RealLoan { LOANCASENO: number; LOAN_AMT: number; PAYMENT_DATE: string; RATE: number; NO_OF_INSTAL: number; PURPOSE: string; }
interface RealTxn { TRANS_DATE: string; TRANS_TYPE: 'DR' | 'CR'; TRANS_AMT: number; RECEIPT_VCHR_NO: string; NARRATION: string; }

const loans: RealLoan[] = real.loans;
const txns: RealTxn[] = real.transactions;

async function disburse(passSvc: PassTransactionService, loanCase: string, amt: number, n: number, rate: number, appDate: Date) {
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [loanCase]);
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1`, [loanCase]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1`, [loanCase]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [loanCase]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${loanCase.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${loanCase}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [loanCase]);

    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,'ALN',$3,$3,$4,$4,$5,'Real legacy replay - 610026821','Y','N')`,
        [loanCase, MBNO, amt, appDate, n]
    );
    const voucherNo = `T${loanCase.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Real legacy replay',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, amt, MBNO, `LOAN_CASE:${loanCase}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1047',0)`,
        [transNo, MBNO, amt, voucherNo]
    );
    const result = await passSvc.passTransaction(voucherNo, 'legacy-replay-610026821');
    console.log(`  Disbursed case ${loanCase} (Rs.${amt.toLocaleString()}, ${appDate.toDateString()}): ${result.message}`);
}

/** Direct ledger insert for a REAL legacy principal-only recovery (legacy
 *  tracked ALN principal (A1047) and interest (I1002) as two entirely
 *  separate GL heads/receipts — never one blended EMI payment the way our
 *  own recordLoanRepayment() assumes. Recording it this way (principal_amount
 *  = the exact real figure, interest_amount = 0) is the faithful replay;
 *  routing it through recordLoanRepayment() would incorrectly re-split it
 *  under OUR OWN equalized schedule, which legacy never used. */
async function applyRealPrincipalPayment(loanCase: string, amt: number, paymentDate: Date, receiptNo: string) {
    await AppDataSource.query(`UPDATE loan_master SET balance = balance - $1 WHERE loancaseno::text = $2`, [amt, loanCase]);
    await AppDataSource.query(
        `INSERT INTO loan_repayment_ledger
            (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
             principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
         VALUES ($1, $2, 'ALN', $3, $4, $5, $6, $6, 0, 0, 0, $7, $8, $9)`,
        [MBNO, loanCase, paymentDate, paymentDate.getMonth() + 1, paymentDate.getFullYear(), amt,
            receiptNo, 'Real legacy principal recovery (Demand Receipt, A1047)', 'legacy-replay-610026821']
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

    console.log(`=== Replaying REAL legacy member 610026821's full ALN history as synthetic member ${MBNO} ===`);
    console.log(`Source: docs/legacy_extract/member_610026821_aln_full.json (${loans.length} real disbursements, ${txns.length} real ledger rows, queried fresh from EMP_Espat_Society_dan)\n`);

    // Wipe EVERYTHING for this synthetic member first — a prior run's final
    // case (still balance > 0) would otherwise get picked up by the very
    // first disbursement's "existing active loan" consolidation query below,
    // silently corrupting every figure downstream.
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE mbno = $1`, [MBNO]);
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE mbno = $1`, [MBNO]);
    await AppDataSource.query(`DELETE FROM ledger WHERE mbno = $1`, [MBNO]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE mbno = $1`, [MBNO]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE mbno = $1`, [MBNO]);
    await AppDataSource.query(`DELETE FROM member_balances WHERE mbno = $1`, [MBNO]);

    let currentCase: string | null = null;
    let loanIdx = 0;
    let txnIdx = 0;

    // Merge the two real chronological streams (disbursements from LOAN_MASTER,
    // principal recoveries from LEDGER) into one ordered replay, exactly as
    // they really happened.
    const events: { date: Date; kind: 'DISBURSE' | 'PAY'; loan?: RealLoan; txn?: RealTxn }[] = [];
    for (const l of loans) events.push({ date: new Date(l.PAYMENT_DATE), kind: 'DISBURSE', loan: l });
    for (const t of txns) {
        if (t.TRANS_TYPE === 'CR') events.push({ date: new Date(t.TRANS_DATE), kind: 'PAY', txn: t });
    }
    events.sort((a, b) => a.date.getTime() - b.date.getTime());

    for (const ev of events) {
        if (ev.kind === 'DISBURSE' && ev.loan) {
            const loanCase = String(ev.loan.LOANCASENO);
            // LOAN_MASTER.NO_OF_INSTAL (80) is case 19578's OWN standalone
            // term as originally applied for — it is NOT the term legacy
            // actually recalculated the COMBINED Rs.3,00,000 balance over.
            // The real combined monthly principal is verifiably Rs.7,500
            // (real ledger rows + the user's own manual figures, whose 5 NR
            // penalty values exactly reproduce our own Tier-2 formula only
            // when principalDue=7,500) => n = 300,000/7,500 = 40, not 80.
            // Using 80 here (as the first replay did) was an unverified
            // parameter choice on my part, not a legacy or app-code fact.
            const isFinalCase = loanCase === '19578';
            const n = isFinalCase ? 40 : ev.loan.NO_OF_INSTAL;
            await disburse(passSvc, loanCase, ev.loan.LOAN_AMT, n, ev.loan.RATE, new Date(ev.loan.PAYMENT_DATE));
            currentCase = loanCase;
        } else if (ev.kind === 'PAY' && ev.txn && currentCase) {
            await applyRealPrincipalPayment(currentCase, ev.txn.TRANS_AMT, new Date(ev.txn.TRANS_DATE), ev.txn.RECEIPT_VCHR_NO);
        }
    }

    // pass-transaction.service.ts:203 always stamps payment_date = new Date()
    // at the moment disbursement is actually processed — never the historical
    // app_date. That's correct for a real live disbursement, but for a
    // REPLAY of real past history it means the schedule anchors to today
    // (script run time) instead of the real 27-Jun-2025 disbursement date,
    // which silently hides 5 real months of overdue installments (no
    // payment since 13-Apr-2026). Correcting payment_date to the real,
    // LOAN_MASTER-confirmed date is restoring a real fact, not a guess.
    const finalLoan = loans[loans.length - 1];
    await AppDataSource.query(
        `UPDATE loan_master SET payment_date = $1 WHERE loancaseno::text = $2`,
        [new Date(finalLoan.PAYMENT_DATE), currentCase]
    );
    console.log(`\n=== Corrected case ${currentCase}'s payment_date to the real disbursement date ${new Date(finalLoan.PAYMENT_DATE).toDateString()} ===`);

    console.log(`\n=== FINAL loan_master state (current active case: ${currentCase}) ===`);
    const finalRows = await AppDataSource.query(
        `SELECT loancaseno, loan_amt, balance, no_of_instal, instal_amt, payment_date, consolidated_into_loancaseno
         FROM loan_master WHERE mbno = $1 ORDER BY loancaseno`, [MBNO]
    );
    console.log(finalRows);

    const currentLoanRow = (await AppDataSource.query(
        `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date
         FROM loan_master WHERE loancaseno::text = $1`, [currentCase]
    ))[0];

    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    const fullSchedule = await (repaymentSvc as any).getInstallmentStatus(queryRunner, currentCase, currentLoanRow, TODAY, true);
    const dueSchedule = await (repaymentSvc as any).getInstallmentStatus(queryRunner, currentCase, currentLoanRow, TODAY, false);
    await queryRunner.release();

    console.log(`\n=== Installments due as of ${TODAY.toDateString()} (includeFuture=false): ${dueSchedule.length} ===`);
    console.log(dueSchedule);

    console.log('\n=== Next upcoming EMI (first not-fully-paid installment) ===');
    const nextEmi = fullSchedule.find((i: any) => !i.isFullyPaid);
    console.log(nextEmi);

    console.log(`\n=== calculateEarlyClosure(${currentCase}, ${TODAY.toDateString()}) — REAL public method ===`);
    const closure = await repaymentSvc.calculateEarlyClosure(currentCase!, TODAY, 0, false);
    console.log(JSON.stringify(closure, null, 2));

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
