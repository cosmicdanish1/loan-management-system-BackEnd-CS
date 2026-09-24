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

// Reproduces PART A's canonical worked example (₹5,00,000 consolidation) end
// to end through the REAL, now-fixed passTransaction() — not hand arithmetic.
// This is also the "point four" regression shape from the internal spec: a
// loan mid-life absorbing an older balance, the same structural pattern as
// the two known-broken legacy cases (#15555/#18094), reconstructed here as a
// live, reachable Postgres fixture since those two are legacy-only /
// unmigrated and calculateEarlyClosure cannot run on them directly (see
// project_legacy_closure_verification memory).
//
// Fixture: old case, ₹5,00,000 / 50 installments / 12% / Slot 1, disbursed
// 2024-06-25 so that exactly 25 of 50 monthly installments are due and paid
// on time (no NR, no penalty) as of today, leaving 25 genuinely future
// installments — the exact scenario Part A / Part B walk through by hand:
//   outstandingPrincipal = 250000, frozenMonthlyInterest = 2650,
//   averageRemainingPrincipal = 130000, averageRbInterest = 1300,
//   apClosureInterest = (2650-1300)*25 = 33750.
// Member holds ₹18,000 Share and ₹21,000 RD against a 5%/5% requirement.

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

const MBNO = '900000003';
const OLD_CASE = '991000';
const NEW_CASE = '991001';
const LOAN_TYPE = 'RLN';
const OLD_LOAN_AMT = 500000;
const OLD_N = 50;
const OLD_INSTAL_AMT = 12650; // 10000 principal + 2650 frozen interest (Slot 1, +1mo delay, 12% p.a.)
// 2024-07-25 (not 06-25): installment 26's due date must land in a month
// AFTER today so it reads as genuinely future, not "already in its due
// month" (isDue is month-granular, not day-exact — see
// project_loan_calculation_pipeline memory / getInstallmentStatus). One
// month earlier made installment 26 due-but-unpaid as of today, adding a
// small real NR+penalty component the clean hand example didn't intend.
const OLD_DISBURSED = new Date(2024, 6, 25); // 25th -> Slot 1
const PAID_INSTALLMENTS = 25;
const OLD_BALANCE_NOW = OLD_LOAN_AMT - PAID_INSTALLMENTS * 10000; // 250000
const FRESH_PRINCIPAL = 250000;
const EXISTING_SHARE = 18000;
const EXISTING_RD = 21000;
const YEARCODE = 1;

async function resetFixture() {
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text IN ($1, $2)`, [OLD_CASE, NEW_CASE]);
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text IN ($1, $2)`, [OLD_CASE, NEW_CASE]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text IN ($1, $2) AND acc_type = $3`, [OLD_CASE, NEW_CASE, LOAN_TYPE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text IN ($1, $2)`, [OLD_CASE, NEW_CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${NEW_CASE.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${NEW_CASE}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [NEW_CASE]);
    // Wipe ALL rd_balance_events for this test member, not just this script's
    // own rows — getCurrentBalance() picks the latest row by (event_date,id),
    // and repeated runs of this or other scripts against the same shared test
    // member (900000002/900000003 are reused across every verify script in
    // this folder) otherwise accumulate and silently change "current RD
    // balance" out from under a supposedly-deterministic fixture (caught live:
    // a leftover row from _verify-share-balance-credit.ts's earlier run
    // pushed this script's intended ₹21,000 RD seed up to ₹37,500).
    await AppDataSource.query(`DELETE FROM rd_balance_events WHERE mbno = $1`, [MBNO]);
    await AppDataSource.query(`UPDATE member_balances SET shares = 1000, regularloan = 0 WHERE mbno = $1`, [MBNO]);
}

async function buildOldLoan() {
    await AppDataSource.query(
        `INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, payment_date, rate, no_of_instal, instal_amt, balance, openbalance, purpose, penalrate, gracedays, smpenalpct, smpenaldiv, delay_months)
         VALUES ($1,$2,$3,$4,$5,12,$6,$7,$8,0,'Worked-example fixture',2,0,1,4,1)`,
        [MBNO, LOAN_TYPE, OLD_CASE, OLD_LOAN_AMT, OLD_DISBURSED, OLD_N, OLD_INSTAL_AMT, OLD_BALANCE_NOW]
    );
    // 25 on-time EMI payments, one per due month (disbursement + i + 1 months,
    // per determineLoanSlot's Slot 1 = +1 month delay), no NR, no penalty.
    for (let i = 1; i <= PAID_INSTALLMENTS; i++) {
        const dueDate = new Date(OLD_DISBURSED);
        dueDate.setMonth(dueDate.getMonth() + i + 1);
        // Dated to the 1st of the due month, not the exact due day (25th) —
        // isDue is month-granular (getInstallmentStatus), but
        // getLedgerHistoryTotals filters payment_date <= asOf day-exactly.
        // The 25th installment's due day can land after "today" even though
        // its due MONTH has already started; paying near month-start avoids
        // that mismatch while real payroll deductions land close to it anyway.
        const paymentDate = new Date(dueDate.getFullYear(), dueDate.getMonth(), 1);
        await AppDataSource.query(
            `INSERT INTO loan_repayment_ledger
                (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                 principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
             VALUES ($1,$2,$3,$4,$5,$6,12650,10000,2650,0,0,NULL,$7,'worked-example-setup')`,
            [MBNO, OLD_CASE, LOAN_TYPE, paymentDate, dueDate.getMonth() + 1, dueDate.getFullYear(), `EMI ${i} - worked example fixture`]
        );
    }
    await AppDataSource.query(`UPDATE member_balances SET shares = $2, regularloan = $3 WHERE mbno = $1`, [MBNO, EXISTING_SHARE, OLD_BALANCE_NOW]);
    await AppDataSource.query(
        `INSERT INTO rd_balance_events (mbno, yearcode, event_date, event_type, amount, resulting_balance, narration, created_by, created_at)
         VALUES ($1,$2,NOW(),'OPENING',$3,$3,'worked-example fixture','worked-example-setup',NOW())`,
        [MBNO, YEARCODE, EXISTING_RD]
    );
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

    await resetFixture();
    await buildOldLoan();

    console.log('=== FIXTURE ===');
    console.log(`Old case ${OLD_CASE}: loan_amt=${OLD_LOAN_AMT}, balance=${OLD_BALANCE_NOW} (25 of 50 installments paid on time)`);
    console.log(`Member ${MBNO}: shares=${EXISTING_SHARE}, RD holdings=${EXISTING_RD}`);
    console.log(`Fresh loan requested: ${FRESH_PRINCIPAL}`);

    const closureQuoteCheck = await loanRepayment.calculateEarlyClosure(OLD_CASE, new Date(), 0, false, MBNO);
    console.log('\n=== INDEPENDENTLY COMPUTED CLOSURE QUOTE (sanity check against hand math) ===');
    console.log({
        outstandingPrincipal: closureQuoteCheck.outstandingPrincipal,
        nrInterest: closureQuoteCheck.nrInterest,
        apInterest: closureQuoteCheck.apInterest,
        penalInterest: closureQuoteCheck.penalInterest,
        averageRemainingPrincipal: closureQuoteCheck.averageRemainingPrincipal,
        averageRbInterest: closureQuoteCheck.averageRbInterest,
    });

    // Independently computed via the real eligibility service, called the
    // same way pass-transaction.service.ts calls it — with sanctionedAmt
    // (fresh principal only), NOT combinedPrincipal. checkEligibility()
    // internally adds the member's existing outstanding itself
    // (totalExposure = existingOutstanding + loanAmount); passing
    // combinedPrincipal here would double-count the old balance.
    const debugDeductions = await loanEligibility.getDisbursementDeductions(MBNO, FRESH_PRINCIPAL, LOAN_TYPE);
    console.log('\n=== INDEPENDENTLY COMPUTED RD/Share deductions (sanity check) ===');
    console.log(debugDeductions);

    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,NOW(),NOW(),$5,'Worked example verification','Y','N')`,
        [NEW_CASE, MBNO, LOAN_TYPE, FRESH_PRINCIPAL, 50]
    );
    const voucherNo = `T${NEW_CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Worked example verification',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, FRESH_PRINCIPAL, MBNO, `LOAN_CASE:${NEW_CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1002',0)`,
        [transNo, MBNO, FRESH_PRINCIPAL, voucherNo]
    );

    console.log('\n=== DISBURSING (consolidation should fire) ===');
    const result = await passSvc.passTransaction(voucherNo, 'worked-example-test');
    console.log('Pass Transaction result:', result);

    const newLoan = (await AppDataSource.query(`SELECT loan_amt, balance FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]))[0];
    const oldClosureRow = (await AppDataSource.query(
        `SELECT payment_amount, principal_amount, interest_amount, penal_amount FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND narration LIKE 'Consolidated into%'`,
        [OLD_CASE]
    ))[0];
    const cashLeg = (await AppDataSource.query(
        `SELECT trans_amt FROM ledger WHERE acc_no::text = $1 AND code = 'A1002' ORDER BY ledgerid DESC LIMIT 1`,
        [NEW_CASE]
    ))[0];
    const sharesAfter = parseFloat((await AppDataSource.query(`SELECT shares FROM member_balances WHERE mbno = $1`, [MBNO]))[0].shares);
    const deductionRows = await AppDataSource.query(
        `SELECT code, trans_amt FROM ledger WHERE acc_no::text = $1 AND trans_type = 'CR' AND code != 'I1002' ORDER BY ledgerid`,
        [NEW_CASE]
    );
    const closureInterestRow = (await AppDataSource.query(
        `SELECT trans_amt FROM ledger WHERE acc_no::text = $1 AND code = 'I1002' ORDER BY ledgerid DESC LIMIT 1`,
        [NEW_CASE]
    ))[0];

    console.log('\n=== RESULT vs PART A\'S EXPECTED WORKED EXAMPLE ===');
    const table = [
        ['loanPrincipal (new combined loan_amt)', 500000, parseFloat(newLoan.loan_amt)],
        ['oldClosureInterest (I1002 posting)', 33750, parseFloat(closureInterestRow?.trans_amt || '0')],
        ['shareShortfall + rdShortfall (sum of CR deductions)', 7000 + 4000, deductionRows.reduce((s: number, r: any) => s + parseFloat(r.trans_amt), 0)],
        ['netDisbursement (cash leg)', 205250, parseFloat(cashLeg?.trans_amt || '0')],
        ['shares after (18000 existing + 7000 shortfall)', 25000, sharesAfter],
    ];
    let allPass = true;
    for (const [label, expected, actual] of table) {
        const pass = Math.abs((expected as number) - (actual as number)) < 0.01;
        console.log(`  ${pass ? 'PASS' : 'FAIL'} - ${label}: expected ${expected}, got ${actual}`);
        if (!pass) allPass = false;
    }
    console.log('\nOld-case closure ledger row (audit trail):', oldClosureRow);
    console.log('Deduction ledger rows (RD/Share):', deductionRows);

    await resetFixture();

    console.log(allPass ? '\nALL CHECKS PASSED — matches Part A worked example exactly' : '\nSOME CHECKS FAILED');
    await AppDataSource.destroy();
    if (!allPass) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
