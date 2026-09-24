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

// Replays a REAL legacy member's real ALN loan sequence (member 30033124,
// "Sushil, Sr Manager" from the legacy MS SQL database) through our own
// fixed disbursement code, using a synthetic test mbno so nothing in our
// live system's real member data is touched. Real amounts, real dates, real
// order, straight from LOAN_MASTER. Also disburses a same-day RLN loan to
// confirm type-scoping doesn't cross-consolidate RLN into ALN or vice versa.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MBNO = '900000501'; // synthetic test member, standing in for real legacy member 30033124
const ALN_LOANS = [
    { case: '778001', amt: 55000, n: 80, date: new Date(2025, 7, 29) },   // 29-Aug-2025
    { case: '778002', amt: 275000, n: 100, date: new Date(2026, 1, 4) }, // 4-Feb-2026
    { case: '778003', amt: 200000, n: 100, date: new Date(2026, 7, 4) }, // 4-Aug-2026
    { case: '778004', amt: 300000, n: 100, date: new Date(2026, 8, 3) }, // 3-Sep-2026
];
const RLN_LOAN = { case: '778005', amt: 525000, n: 50, date: new Date(2026, 6, 17) }; // 17-Jul-2026

async function disburse(passSvc: PassTransactionService, mbno: string, loanCase: string, loanType: string, amt: number, n: number, appDate: Date) {
    await AppDataSource.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [loanCase]);
    await AppDataSource.query(`DELETE FROM ledger WHERE acc_no::text = $1`, [loanCase]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [loanCase]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${loanCase.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${loanCase}|%`]);
    await AppDataSource.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1`, [loanCase]);

    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'Legacy replay test','Y','N')`,
        [loanCase, mbno, loanType, amt, appDate, n]
    );
    const voucherNo = `T${loanCase.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Legacy replay test',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, amt, mbno, `LOAN_CASE:${loanCase}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    const headCode = loanType === 'RLN' ? 'A1002' : 'A1047';
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement',$5,0)`,
        [transNo, mbno, amt, voucherNo, headCode]
    );
    const result = await passSvc.passTransaction(voucherNo, 'legacy-replay-test');
    console.log(`  Disbursed ${loanType} case ${loanCase} (Rs.${amt.toLocaleString()}, ${appDate.toDateString()}): ${result.message}`);
}

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

    console.log(`=== Replaying real legacy member 30033124's ALN sequence as synthetic member ${MBNO} ===`);
    for (const loan of ALN_LOANS) {
        await disburse(passSvc, MBNO, loan.case, 'ALN', loan.amt, loan.n, loan.date);
    }
    console.log(`\n=== Also disbursing the member's real same-period RLN loan, to confirm no cross-type consolidation ===`);
    await disburse(passSvc, MBNO, RLN_LOAN.case, 'RLN', RLN_LOAN.amt, RLN_LOAN.n, RLN_LOAN.date);

    console.log('\n=== FINAL STATE ===');
    const alnRows = await AppDataSource.query(
        `SELECT loancaseno, loan_amt, balance, consolidated_into_loancaseno FROM loan_master WHERE mbno = $1 AND loantype='ALN' ORDER BY loancaseno`,
        [MBNO]
    );
    console.log('ALN loan_master rows:', alnRows);
    const rlnRows = await AppDataSource.query(
        `SELECT loancaseno, loan_amt, balance, consolidated_into_loancaseno FROM loan_master WHERE mbno = $1 AND loantype='RLN' ORDER BY loancaseno`,
        [MBNO]
    );
    console.log('RLN loan_master rows:', rlnRows);

    const expectedGross = ALN_LOANS.reduce((s, l) => s + l.amt, 0);
    const finalAlnCase = ALN_LOANS[ALN_LOANS.length - 1].case;
    const finalAlnRow = alnRows.find((r: any) => r.loancaseno === finalAlnCase);
    const consolidatedCount = alnRows.filter((r: any) => r.consolidated_into_loancaseno).length;

    console.log('\n=== CHECKS ===');
    const checks: [string, boolean][] = [
        ['All 3 earlier ALN cases consolidated into the final one', consolidatedCount === 3],
        [`Final ALN case (${finalAlnCase}) balance = gross sum of all 4 (Rs.${expectedGross.toLocaleString()})`,
            finalAlnRow && Math.abs(parseFloat(finalAlnRow.balance) - expectedGross) < 0.01],
        ['RLN loan untouched by ALN consolidation (its own independent balance)',
            rlnRows.length === 1 && Math.abs(parseFloat(rlnRows[0].balance) - RLN_LOAN.amt) < 0.01 && !rlnRows[0].consolidated_into_loancaseno],
    ];
    let allPass = true;
    for (const [label, pass] of checks) {
        console.log(`  ${pass ? 'PASS' : 'FAIL'} - ${label}`);
        if (!pass) allPass = false;
    }
    console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');

    await AppDataSource.destroy();
    if (!allPass) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
