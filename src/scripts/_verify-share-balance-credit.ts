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

// Verifies BUG FIX: Share shortfall withheld at loan disbursement now credits
// member_balances.shares (the same column executeEarlyClosure debits), the
// way RD shortfall already credited rd_balance_events. Uses member 900000002
// with NO active MLN loan (so no consolidation branch fires — isolates the
// Share/RD withholding path from the oldClosureInterest logic tested
// elsewhere), sized so a genuine Share (and likely RD) shortfall triggers.

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
const NEW_CASE = '777910';
const LOAN_TYPE = 'RLN';
const LOAN_AMT = 600000;
const N = 60;
const APP_DATE = new Date(2027, 6, 27); // 27th -> Slot 1

async function resetFixture() {
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

    const sharesBefore = parseFloat((await AppDataSource.query(`SELECT COALESCE(shares,0) as v FROM member_balances WHERE mbno = $1`, [MBNO]))[0]?.v || '0');

    // Independently compute the expected deductions, the same way the
    // previous verification scripts independently computed their expected
    // quotes, so this checks "did it credit the RIGHT amount", not just
    // "did it credit something".
    const expectedDeductions = await loanEligibility.getDisbursementDeductions(MBNO, LOAN_AMT, LOAN_TYPE);
    const expectedShareDeduction = expectedDeductions.find(d => d.kind === 'SHARE');
    const expectedRdDeduction = expectedDeductions.find(d => d.kind === 'RD');
    console.log('Existing shares before:', sharesBefore);
    console.log('Expected deductions:', expectedDeductions);

    if (!expectedShareDeduction || expectedShareDeduction.amount <= 0) {
        console.log('FAIL - test fixture no longer produces a Share shortfall for this loan amount; adjust LOAN_AMT');
        await AppDataSource.destroy();
        process.exit(1);
    }

    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'Share balance credit verification','Y','N')`,
        [NEW_CASE, MBNO, LOAN_TYPE, LOAN_AMT, APP_DATE, N]
    );
    const voucherNo = `T${NEW_CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Share balance credit verification',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, LOAN_AMT, MBNO, `LOAN_CASE:${NEW_CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1002',0)`,
        [transNo, MBNO, LOAN_AMT, voucherNo]
    );

    console.log('\n=== DISBURSING ===');
    const result = await passSvc.passTransaction(voucherNo, 'share-balance-credit-test');
    console.log('Pass Transaction result:', result);

    const sharesAfter = parseFloat((await AppDataSource.query(`SELECT COALESCE(shares,0) as v FROM member_balances WHERE mbno = $1`, [MBNO]))[0]?.v || '0');
    console.log(`\nshares before=${sharesBefore}, after=${sharesAfter}, delta=${(sharesAfter - sharesBefore).toFixed(2)} (expect ${expectedShareDeduction.amount})`);

    let allPass = true;
    const check = (label: string, pass: boolean) => { console.log(`  ${pass ? 'PASS' : 'FAIL'} - ${label}`); if (!pass) allPass = false; };

    check(
        `member_balances.shares credited by exactly the withheld Share shortfall (₹${expectedShareDeduction.amount})`,
        Math.abs((sharesAfter - sharesBefore) - expectedShareDeduction.amount) < 0.01
    );

    if (expectedRdDeduction && expectedRdDeduction.amount > 0) {
        const rdEventRow = (await AppDataSource.query(
            `SELECT amount, event_type, narration FROM rd_balance_events WHERE mbno = $1 ORDER BY id DESC LIMIT 1`,
            [MBNO]
        ))[0];
        console.log('Most recent rd_balance_events row:', rdEventRow);
        check(
            `RD path unaffected (regression check) — rd_balance_events still recorded ₹${expectedRdDeduction.amount}`,
            rdEventRow && Math.abs(parseFloat(rdEventRow.amount) - expectedRdDeduction.amount) < 0.01
        );
    } else {
        console.log('  (no RD shortfall for this scenario — regression check skipped)');
    }

    // Cleanup — reverse the shares credit AND the regularloan/emergency_loan_balance
    // increment that passTransaction() also applies on disbursement (missed in an
    // earlier run of this script, which left member_balances.regularloan at 600000
    // with zero real active RLN loans backing it — exactly the kind of drift the
    // reconciliation guard in pass-transaction.service.ts now exists to catch).
    const balanceColForCleanup = LOAN_TYPE === 'RLN' ? 'regularloan' : 'emergency_loan_balance';
    await AppDataSource.query(
        `UPDATE member_balances SET shares = $2, ${balanceColForCleanup} = GREATEST(0, COALESCE(${balanceColForCleanup}, 0) - $3) WHERE mbno = $1`,
        [MBNO, sharesBefore, LOAN_AMT]
    );
    await resetFixture();

    console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
    await AppDataSource.destroy();
    if (!allPass) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
