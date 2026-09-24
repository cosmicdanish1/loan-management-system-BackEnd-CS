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

// Verifies oldClosureInterest end-to-end using a genuinely clean, real fixture:
// case 777900 (member 900000002, RLN, ₹40,000, 15 installments, disbursed
// 2026-09-17, ZERO repayments posted yet — loan_master.balance, loan_amt and
// member_balances.regularloan all already agree at 40000). Consolidating a
// fresh RLN loan into it should price AP interest on the (mostly or entirely
// future) remaining installments, withhold it from the fresh cash, and post
// it auditably — with NR/penal both expected at ~0 since nothing is overdue.

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
const NEW_CASE = '777901';
const LOAN_TYPE = 'RLN';
const NEW_LOAN_AMT = 20000;
const N = 12;
const APP_DATE = new Date(2027, 6, 27); // 27th -> Slot 1

async function resetFixture() {
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND narration LIKE 'Consolidated into%'`, [EXISTING_CASE]);
    await AppDataSource.query(`UPDATE loan_master SET balance = 40000, consolidated_into_loancaseno = NULL WHERE loancaseno::text = $1`, [EXISTING_CASE]);
    await AppDataSource.query(`UPDATE member_balances SET regularloan = 40000 WHERE mbno = $1`, [MBNO]);
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1 AND acc_type = $2`, [NEW_CASE, LOAN_TYPE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${NEW_CASE.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${NEW_CASE}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [NEW_CASE]);
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

    // Independently compute what oldClosureInterest SHOULD be, using the same
    // read-only quote function passTransaction now calls internally, so this
    // script isn't just checking "did it run" but "did it charge the right
    // amount".
    const expectedQuote = await loanRepayment.calculateEarlyClosure(EXISTING_CASE, new Date(), 0, false, MBNO);
    const expectedOldClosureInterest = Math.round((expectedQuote.nrInterest + expectedQuote.apInterest + expectedQuote.penalInterest) * 100) / 100;
    console.log('Independently computed closure quote for case 777900:', {
        outstandingPrincipal: expectedQuote.outstandingPrincipal,
        nrInterest: expectedQuote.nrInterest,
        apInterest: expectedQuote.apInterest,
        penalInterest: expectedQuote.penalInterest,
        expectedOldClosureInterest,
    });

    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'oldClosureInterest verification','Y','N')`,
        [NEW_CASE, MBNO, LOAN_TYPE, NEW_LOAN_AMT, APP_DATE, N]
    );
    const voucherNo = `T${NEW_CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'oldClosureInterest verification',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, NEW_LOAN_AMT, MBNO, `LOAN_CASE:${NEW_CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1002',0)`,
        [transNo, MBNO, NEW_LOAN_AMT, voucherNo]
    );

    console.log('\n=== DISBURSING (should consolidate + charge oldClosureInterest) ===');
    const result = await passSvc.passTransaction(voucherNo, 'old-closure-interest-test');
    console.log('Pass Transaction result:', result);

    console.log('\n=== AFTER ===');
    const newLoan = (await AppDataSource.query(`SELECT loan_amt, balance FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]))[0];
    const oldClosureRow = (await AppDataSource.query(
        `SELECT payment_amount, principal_amount, interest_amount, penal_amount, narration FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND narration LIKE 'Consolidated into%'`,
        [EXISTING_CASE]
    ))[0];
    const closureInterestLedgerRow = (await AppDataSource.query(
        `SELECT trans_amt, trans_type, narration FROM ledger WHERE code = 'I1002' AND acc_no::text = $1 ORDER BY ledgerid DESC LIMIT 1`,
        [NEW_CASE]
    ))[0];
    const cashLeg = (await AppDataSource.query(
        `SELECT trans_amt FROM ledger WHERE acc_no::text = $1 AND code IN ('A1002','A1047') ORDER BY ledgerid DESC LIMIT 1`,
        [NEW_CASE]
    ))[0];

    console.log(`New case loan_amt=${newLoan?.loan_amt} (expect 60000), balance=${newLoan?.balance} (expect 60000)`);
    console.log(`Old case loan_repayment_ledger row:`, oldClosureRow);
    console.log(`I1002 closure-interest ledger row:`, closureInterestLedgerRow);
    console.log(`Disbursement cash leg:`, cashLeg);

    let allPass = true;
    const check = (label: string, pass: boolean) => { console.log(`  ${pass ? 'PASS' : 'FAIL'} - ${label}`); if (!pass) allPass = false; };

    check('expectedOldClosureInterest > 0 (future installments exist, so AP should be nonzero)', expectedOldClosureInterest > 0);
    check('new case loan_amt = 60000 (combined, old interest NOT added to principal)', Math.abs(parseFloat(newLoan?.loan_amt) - 60000) < 0.01);
    check('old-case ledger row exists', !!oldClosureRow);
    check(
        `old-case principal_amount = 40000 exactly (old principal transferred, not inflated by interest): got ${oldClosureRow?.principal_amount}`,
        oldClosureRow && Math.abs(parseFloat(oldClosureRow.principal_amount) - 40000) < 0.01
    );
    check(
        `old-case interest_amount+penal_amount ≈ expectedOldClosureInterest (${expectedOldClosureInterest}): got ${oldClosureRow ? parseFloat(oldClosureRow.interest_amount) + parseFloat(oldClosureRow.penal_amount) : 'N/A'}`,
        oldClosureRow && Math.abs((parseFloat(oldClosureRow.interest_amount) + parseFloat(oldClosureRow.penal_amount)) - expectedOldClosureInterest) < 0.01
    );
    check(
        `old-case payment_amount = principal + interest + penal (no silent netting): got ${oldClosureRow?.payment_amount}`,
        oldClosureRow && Math.abs(parseFloat(oldClosureRow.payment_amount) - (40000 + expectedOldClosureInterest)) < 0.01
    );
    check('I1002 closure-interest ledger row exists (auditable posting, not hidden)', !!closureInterestLedgerRow);
    check(
        `I1002 amount ≈ expectedOldClosureInterest: got ${closureInterestLedgerRow?.trans_amt}`,
        closureInterestLedgerRow && Math.abs(parseFloat(closureInterestLedgerRow.trans_amt) - expectedOldClosureInterest) < 0.01
    );
    check(
        `disbursement cash leg = NEW_LOAN_AMT - oldClosureInterest (= ${(NEW_LOAN_AMT - expectedOldClosureInterest).toFixed(2)}, before any RD/Share shortfall): got ${cashLeg?.trans_amt}`,
        cashLeg && parseFloat(cashLeg.trans_amt) <= (NEW_LOAN_AMT - expectedOldClosureInterest) + 0.01
    );

    // Leave the fixture clean and reusable for the next run.
    await resetFixture();
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [NEW_CASE]);

    console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
    await AppDataSource.destroy();
    if (!allPass) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
