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

// database.config.ts is being actively edited on disk outside this session
// right now (confirmed: its content changed between two script runs a
// minute apart), so this script opens its OWN direct connection instead of
// importing the shared AppDataSource singleton, using the same credentials
// db-config.json / the working mcp postgres tool already confirm are correct.
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

// Drives a loan through the REAL live disbursement path (loan_pending ->
// staged voucher -> PassTransactionService.passTransaction()) -- not the
// calculateConstantEmi() utility called in isolation -- to prove the actual
// wired-up code produces the RB schedule + constant EMI + slot logic
// correctly. Then verifies early closure sources interest from the RB
// schedule and that the quote and executed amounts agree.

const MBNO = '900000002';

function round2(x: number) { return Math.round(x * 100) / 100; }
function d(y: number, m: number, day: number) { return new Date(y, m - 1, day); }

async function setupAndActivate(dataSource: any, caseNo: string, appDate: Date, sanctionedAmt: number, noOfInstal: number, loanType: string) {
    await dataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [caseNo]);
    await dataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [caseNo]);
    await dataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [caseNo]);
    await dataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no LIKE $1`, [`T${caseNo.slice(-5)}%`]);
    await dataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${caseNo}|%`]);
    await dataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [caseNo]);

    await dataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'e2e-test','Y','N')`,
        [caseNo, MBNO, loanType, sanctionedAmt, appDate, noOfInstal]
    );

    const voucherNo = `T${caseNo.slice(-5)}`;
    const maxId = (await dataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await dataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'e2e test loan disbursement',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, sanctionedAmt, MBNO, `LOAN_CASE:${caseNo}|PAY_MODE:CASH`]
    );

    const transNo = (await dataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await dataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1047',0)`,
        [transNo, MBNO, sanctionedAmt, voucherNo]
    );

    return voucherNo;
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
    const passSvc = new PassTransactionService(AppDataSource, sysConfig, loanEligibility, rdBalanceEvents);
    const repaySvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);

    const checks: { label: string; pass: boolean; expected: any; actual: any }[] = [];
    function check(label: string, expected: number, actual: number, tol = 0.02) {
        const pass = Math.abs(expected - actual) <= tol;
        checks.push({ label, pass, expected, actual });
    }

    // ===== Slot 1: app_date = 25th (25th-5th window) =====
    {
        const CASE = '888801';
        const appDate = d(2027, 3, 25); // 25th -> Slot 1
        const voucherNo = await setupAndActivate(AppDataSource, CASE, appDate, 300000, 30, 'ELN');
        console.log(`\n--- Slot 1 test: app_date=${appDate.toDateString()}, voucher=${voucherNo} ---`);
        const result = await passSvc.passTransaction(voucherNo, 'e2e-test');
        console.log('passTransaction result:', result);

        const loanRow = (await AppDataSource.query(`SELECT instal_amt, rate, intt_amount FROM loan_master WHERE loancaseno::text = $1`, [CASE]))[0];
        check('Slot1 loan_master.instal_amt = constant EMI 11650', 11650, parseFloat(loanRow.instal_amt));
        check('Slot1 loan_master.intt_amount = monthlyInterestForEMI', round2(49500 / 30), parseFloat(loanRow.intt_amount));

        const rbRows = await AppDataSource.query(`SELECT installment_no, opening_balance, rb_interest, principal, closing_balance FROM loan_rb_schedule WHERE loancaseno::text = $1 ORDER BY installment_no`, [CASE]);
        check('Slot1 RB schedule has 30 rows', 30, rbRows.length);
        check('Slot1 RB row #1 interest = 3000', 3000, parseFloat(rbRows[0].rb_interest));
        check('Slot1 RB row #30 interest = 100', 100, parseFloat(rbRows[29].rb_interest));
        check('Slot1 RB row #30 closing balance = 0', 0, parseFloat(rbRows[29].closing_balance));
        const totalRB = rbRows.reduce((s: number, r: any) => s + parseFloat(r.rb_interest), 0);
        check('Slot1 sum of RB interest = 46500', 46500, round2(totalRB));

        // Early closure quote vs executed, using RB interest
        const closeDate = d(2027, 5, 10); // 2 months after activation-ish, a couple installments unpaid
        const quote = await repaySvc.calculateEarlyClosure(CASE, closeDate);
        console.log('Early closure quote:', JSON.stringify(quote, null, 2));
        const exec = await repaySvc.executeEarlyClosure(CASE, closeDate, 0, 'e2e-test', 'E2E-CLOSE-1');
        console.log('Early closure executed:', exec);
        check('Slot1 closure: quote == executed', quote.finalClosureAmount, exec.finalClosureAmount);
    }

    // ===== Slot 2: app_date = 15th (6th-24th window) =====
    {
        const CASE = '888802';
        const appDate = d(2027, 3, 15); // 15th -> Slot 2
        const voucherNo = await setupAndActivate(AppDataSource, CASE, appDate, 300000, 30, 'ELN');
        console.log(`\n--- Slot 2 test: app_date=${appDate.toDateString()}, voucher=${voucherNo} ---`);
        const result = await passSvc.passTransaction(voucherNo, 'e2e-test');
        console.log('passTransaction result:', result);

        const loanRow = (await AppDataSource.query(`SELECT instal_amt, rate, intt_amount FROM loan_master WHERE loancaseno::text = $1`, [CASE]))[0];
        check('Slot2 loan_master.instal_amt = constant EMI 11750', 11750, parseFloat(loanRow.instal_amt));

        const rbRows = await AppDataSource.query(`SELECT installment_no, rb_interest, closing_balance FROM loan_rb_schedule WHERE loancaseno::text = $1 ORDER BY installment_no`, [CASE]);
        check('Slot2 RB schedule has 30 rows', 30, rbRows.length);
        const totalRB2 = rbRows.reduce((s: number, r: any) => s + parseFloat(r.rb_interest), 0);
        check('Slot2 sum of RB interest = 46500 (RB schedule itself is slot-independent)', 46500, round2(totalRB2));
    }

    // Cleanup
    for (const CASE of ['888801', '888802']) {
        await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
        await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [CASE]);
        await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
        await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${CASE.slice(-5)}`]);
        await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${CASE}|%`]);
        await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [CASE]);
    }

    console.log('\n\n========== RESULTS ==========');
    let passCount = 0;
    for (const c of checks) {
        const mark = c.pass ? 'PASS' : 'FAIL';
        if (c.pass) passCount++;
        console.log(`[${mark}] ${c.label} | expected=${c.expected} actual=${c.actual}`);
    }
    console.log(`\n${passCount}/${checks.length} passed.`);

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
