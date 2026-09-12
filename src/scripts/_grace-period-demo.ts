import { AppDataSource } from '../config/database.config';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Demonstrates the new grace-period + exact-date-fix code, driven through the
// REAL LoanRepaymentService (recordLoanRepayment / getDueStatus / calculateEarlyClosure) —
// not a simulation. Inserts one throwaway loan_master row matching the user's
// worked example (₹300,000 Emergency Loan, 12% rate, 30 months, disbursed
// 2026-09-25), with the values now actually live in busrules frozen onto it
// (penalrate=15, gracedays=5), then cleans up afterward.

const MBNO = '900000002';
const CASE = '999901';
const LOAN_AMT = 300000;
const RATE = 12;
const PENAL_RATE = 15; // live busrules.elnpenalrate right now
const GRACE_DAYS = 5;  // live busrules.elngracedays right now
const N = 30;
const DISBURSED = new Date(2026, 8, 25); // Sept 25, 2026

function round2(x: number) { return Math.round(x * 100) / 100; }
function d(y: number, m: number, day: number) { return new Date(y, m - 1, day); }

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const svc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);

    const monthlyRate = RATE / 100 / 12;
    const instalAmt = round2((LOAN_AMT * monthlyRate * Math.pow(1 + monthlyRate, N)) / (Math.pow(1 + monthlyRate, N) - 1));
    console.log('EMI (instal_amt):', instalAmt);

    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
    await AppDataSource.query(`DELETE FROM demand_master WHERE mbno = $1 AND demand_for_year IN (2026,2027)`, [MBNO]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
    await AppDataSource.query(
        `INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, balance, openbalance, rate, no_of_instal, instal_amt, payment_date, purpose, intt_amount, penalrate, gracedays)
         VALUES ($1,'ELN',$2,$3,$3,0,$4,$5,$6,$7,'grace-demo',$8,$9,$10)`,
        [MBNO, CASE, LOAN_AMT, RATE, N, instalAmt, DISBURSED, round2(LOAN_AMT * RATE / 1200), PENAL_RATE, GRACE_DAYS]
    );
    console.log(`Test loan ${CASE} created: ELN ₹${LOAN_AMT}, ${RATE}% rate, ${PENAL_RATE}% penal, ${GRACE_DAYS} days grace, ${N} months, disbursed ${DISBURSED.toDateString()}`);

    async function pay(amount: number, asOf: Date, note: string) {
        const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: amount, asOfDate: asOf, narration: note, username: 'grace-demo' } as any);
        console.log(`  PAY ₹${amount} @ ${asOf.toDateString()} — ${r.message}`);
    }
    async function due(asOf: Date, label: string) {
        const s = await svc.getDueStatus(CASE, asOf);
        console.log(`  DUE STATUS @ ${asOf.toDateString()} (${label}): totalDue=₹${s.totalDue} (P:${s.totalPrincipalDue} I:${s.totalInterestDue} Penal:${s.totalPenalDue})`);
        for (const i of s.unpaidInstallments) {
            console.log(`    #${i.installmentNo} due ${i.dueDate} — principalDue:${i.principalDue} interestDue:${i.interestDue} penalDue:${i.penalDue} monthsOverdue:${i.monthsOverdue}`);
        }
        return s;
    }

    console.log('\n--- 9 on-time EMIs (installments 1-9) ---');
    for (let m = 1; m <= 9; m++) {
        const dd = new Date(DISBURSED); dd.setMonth(dd.getMonth() + m);
        await pay(instalAmt, dd, `On-time installment ${m}`);
    }

    console.log('\n--- Installment #10 (due 2027-07-25) missed. Checking penal at several points relative to the 5-day grace window ---');
    await due(d(2027, 7, 26), '1 day late — within 5-day grace');
    await due(d(2027, 7, 30), '5 days late — last day of grace');
    await due(d(2027, 7, 31), '6 days late — 1 day past grace');
    await due(d(2027, 8, 24), '30 days late');
    await due(d(2027, 9, 10), '47 days late, #11 also missed, #12 not yet due (was wrongly swept in before the fix)');

    console.log('\n--- Early closure quote as of 2027-09-10 (real calculateEarlyClosure) ---');
    const quote = await svc.calculateEarlyClosure(CASE, d(2027, 9, 10));
    console.log(JSON.stringify(quote, null, 2));

    console.log('\n--- Cleanup ---');
    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
    await AppDataSource.query(`DELETE FROM demand_master WHERE mbno = $1 AND demand_for_year IN (2026,2027)`, [MBNO]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
    console.log('Test loan and ledger rows removed.');

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
