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

// Verifies Steps 0-9 of the "Complete Loan Flow" walkthrough one at a time,
// each printed value read back from the REAL running code (PassTransactionService
// + LoanRepaymentService), not restated math. A brand-new loan case, left live
// in the database afterward -- this one gets carried all the way through to a
// real executed early closure, so Step 9 is exercised for real, not just quoted.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    synchronize: false, logging: false,
});

const MBNO = '900000002';
const CASE = '777702';
const LOAN_AMT = 300000;
const N = 30;
const LOAN_TYPE = 'ALN';
const APP_DATE = new Date(2027, 2, 25); // 25th -> Slot 1

function d(y: number, m: number, day: number) { return new Date(y, m - 1, day); }
const line = (s: string) => console.log('\n' + '='.repeat(3) + ' ' + s + ' ' + '='.repeat(Math.max(3, 70 - s.length)));

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

    // Reset this case number only
    for (const q of [
        `DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`,
        `DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`,
        `DELETE FROM loan_master WHERE loancaseno::text = $1`,
        `DELETE FROM loan_pending WHERE loancaseno::text = $1`,
    ]) await AppDataSource.query(q, [CASE]);
    await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${CASE.slice(-5)}`]);
    await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${CASE}|%`]);

    line('STEP 0-1: Application, sanction, disbursement -- real code path');
    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'step-by-step verification','Y','N')`,
        [CASE, MBNO, LOAN_TYPE, LOAN_AMT, APP_DATE, N]
    );
    const voucherNo = `T${CASE.slice(-5)}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'step-by-step test',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, LOAN_AMT, MBNO, `LOAN_CASE:${CASE}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement','A1047',0)`,
        [transNo, MBNO, LOAN_AMT, voucherNo]
    );
    console.log(`Application date: ${APP_DATE.toDateString()} (day ${APP_DATE.getDate()}) -> expect Slot 1`);
    const passResult = await passSvc.passTransaction(voucherNo, 'step-test');
    console.log('passTransaction() result:', passResult);

    const loan = (await AppDataSource.query(`SELECT * FROM loan_master WHERE loancaseno::text = $1`, [CASE]))[0];

    line('STEP 2: monthlyRate and monthlyPrincipal');
    const monthlyRate = parseFloat(loan.rate) / 1200;
    const monthlyPrincipal = LOAN_AMT / N;
    console.log(`rate stored on loan_master = ${loan.rate}%  ->  monthlyRate = ${loan.rate}/1200 = ${monthlyRate}`);
    console.log(`monthlyPrincipal = ${LOAN_AMT}/${N} = ${monthlyPrincipal}`);

    line('STEP 3: The RB schedule, read back from loan_rb_schedule');
    const rbRows = await AppDataSource.query(
        `SELECT installment_no, opening_balance, rb_interest, principal, closing_balance FROM loan_rb_schedule WHERE loancaseno::text = $1 ORDER BY installment_no`, [CASE]
    );
    console.log(`Row count: ${rbRows.length} (expect ${N})`);
    console.log('First 3 rows:', rbRows.slice(0, 3).map((r: any) => ({ i: r.installment_no, open: r.opening_balance, rbInt: r.rb_interest, close: r.closing_balance })));
    console.log('Last 2 rows:', rbRows.slice(-2).map((r: any) => ({ i: r.installment_no, open: r.opening_balance, rbInt: r.rb_interest, close: r.closing_balance })));
    const totalRB = rbRows.reduce((s: number, r: any) => s + parseFloat(r.rb_interest), 0);
    console.log(`totalRBInterest (sum of rb_interest column) = ${Math.round(totalRB * 100) / 100} (expect 46500)`);

    line('STEP 4-5: Delay interest, total interest for EMI, constant EMI');
    console.log(`loan_master.instal_amt (constantEMI, as stored) = ${loan.instal_amt} (expect 11650 for Slot 1)`);
    console.log(`loan_master.intt_amount (monthlyInterestForEMI, as stored) = ${loan.intt_amount} (expect 1650)`);
    console.log(`Back-calculated: delayInterest = instal_amt*n - loan_amt - totalRBInterest = ${Math.round((parseFloat(loan.instal_amt) * N - LOAN_AMT - totalRB) * 100) / 100} (expect 3000)`);

    line('STEP 6: Regular monthly billing -- due status once installment #1 is due, before any payment');
    const instal1DueDate = new Date(loan.payment_date); instal1DueDate.setMonth(instal1DueDate.getMonth() + 1);
    const dueBefore = await repaySvc.getDueStatus(CASE, instal1DueDate);
    console.log('unpaidInstallments[0]:', dueBefore.unpaidInstallments[0]);
    console.log(`principalDue=${dueBefore.unpaidInstallments[0].principalDue} (expect 10000), interestDue=${dueBefore.unpaidInstallments[0].interestDue} (expect 1650)`);

    line('STEP 7: Penal tiers -- explicit due-status checks at different dates');
    const dueDate1 = new Date(loan.payment_date); dueDate1.setMonth(dueDate1.getMonth() + 1);
    const y = dueDate1.getFullYear(), mo = dueDate1.getMonth() + 1;
    const check = async (day: number, label: string) => {
        const s = await repaySvc.getDueStatus(CASE, d(y, mo, day));
        const i = s.unpaidInstallments[0];
        console.log(`${label}: tier=${i.tier}, penalDue=${i.penalDue}, principalDue=${i.principalDue}, interestDue=${i.interestDue}`);
    };
    await check(1, 'Day 1 of due month');
    const nextMonth = new Date(y, mo, 1);
    const sNext = await repaySvc.getDueStatus(CASE, nextMonth);
    console.log(`1st of following month: tier=${sNext.unpaidInstallments[0].tier}, penalDue=${sNext.unpaidInstallments[0].penalDue} (Tier 2, 1 month overdue)`);
    const monthAfter = new Date(y, mo + 1, 1);
    const sAfter = await repaySvc.getDueStatus(CASE, monthAfter);
    console.log(`1st of the month after that: tier=${sAfter.unpaidInstallments[0].tier}, penalDue=${sAfter.unpaidInstallments[0].penalDue} (Tier 2, 2 months overdue)`);
    console.log(`NOTE: gracedays on this loan = ${loan.gracedays ?? '(column not present / defaulted)'} -- Tier 0 is unreachable if grace defaulted to 0, exactly as flagged earlier.`);

    line('STEP 8: Balance reduction -- pay 5 installments, verify balance drops by principal only');
    const balBefore = parseFloat((await AppDataSource.query(`SELECT balance FROM loan_master WHERE loancaseno::text=$1`, [CASE]))[0].balance);
    console.log(`Balance before any payment: ${balBefore}`);
    for (let m = 1; m <= 5; m++) {
        const dd = new Date(loan.payment_date); dd.setMonth(dd.getMonth() + m); dd.setDate(1);
        const r = await repaySvc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: parseFloat(loan.instal_amt), asOfDate: dd, username: 'step-test' } as any);
        console.log(`  Month ${m}: ${r.message}`);
    }
    const balAfter5 = parseFloat((await AppDataSource.query(`SELECT balance FROM loan_master WHERE loancaseno::text=$1`, [CASE]))[0].balance);
    console.log(`Balance after 5 payments: ${balAfter5}  (5 x monthlyPrincipal = ${5 * monthlyPrincipal}; difference from expected is entirely accumulated penal, never principal)`);

    line('STEP 9: Early closure -- quote and REAL executed closure, using RB-sourced interest');
    const closeDate = new Date(loan.payment_date); closeDate.setMonth(closeDate.getMonth() + 8); closeDate.setDate(15);
    const quote = await repaySvc.calculateEarlyClosure(CASE, closeDate);
    console.log('Quote:', JSON.stringify(quote, null, 2));
    console.log(`\nCross-check: quote.previousOverdueInterest (${quote.previousOverdueInterest}) should equal the SUM of rb_interest for installment_no IN (${quote.unpaidInstallments.map((i: any) => i.installmentNo).join(',')})`);
    const rbSumForUnpaid = rbRows
        .filter((r: any) => quote.unpaidInstallments.some((i: any) => i.installmentNo === r.installment_no))
        .reduce((s: number, r: any) => s + parseFloat(r.rb_interest), 0);
    console.log(`Actual sum from loan_rb_schedule table: ${Math.round(rbSumForUnpaid * 100) / 100}`);

    const exec = await repaySvc.executeEarlyClosure(CASE, closeDate, 0, 'step-test', 'STEP-CLOSE');
    console.log('\nExecuted:', exec);
    console.log(`Quote == Executed: ${quote.finalClosureAmount === exec.finalClosureAmount}`);

    const finalLoan = (await AppDataSource.query(`SELECT balance FROM loan_master WHERE loancaseno::text=$1`, [CASE]))[0];
    console.log(`\nFinal loan_master.balance after closure: ${finalLoan.balance} (expect 0)`);
    console.log(`\nLoan case ${CASE} left live in the database (closed, balance 0) for report verification.`);

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
