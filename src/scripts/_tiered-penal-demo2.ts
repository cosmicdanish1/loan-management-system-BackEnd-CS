import { AppDataSource } from '../config/database.config';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const MBNO = '900000002';
const CASE = '999905';
const LOAN_AMT = 300000, RATE = 12, PENAL_RATE = 15, GRACE_DAY = 15, SM_PCT = 1, SM_DIV = 4, N = 30;
const DISBURSED = new Date(2026, 8, 25); // installment #10 due "for" July 2027

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

    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
    await AppDataSource.query(
        `INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, balance, openbalance, rate, no_of_instal, instal_amt, payment_date, purpose, intt_amount, penalrate, gracedays, smpenalpct, smpenaldiv)
         VALUES ($1,'ELN',$2,$3,$3,0,$4,$5,$6,$7,'tiered-penal-demo2',$8,$9,$10,$11,$12)`,
        [MBNO, CASE, LOAN_AMT, RATE, N, instalAmt, DISBURSED, round2(LOAN_AMT * RATE / 1200), PENAL_RATE, GRACE_DAY, SM_PCT, SM_DIV]
    );

    // Pay on the 10th of each month (WITHIN the grace window, day<=15) —
    // this is what "genuinely on-time" means under the new rule.
    for (let m = 1; m <= 9; m++) {
        const dd = new Date(DISBURSED); dd.setMonth(dd.getMonth() + m); dd.setDate(10);
        const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: instalAmt, asOfDate: dd, narration: `On-time ${m}`, username: 'demo' } as any);
        if (!r.message.includes('Covered')) console.log(`  WARNING month ${m}: ${r.message}`);
    }
    const bal = await AppDataSource.query(`SELECT balance FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
    console.log(`After 9 genuinely on-time (day-10) EMIs: balance = ₹${bal[0].balance} (expect exactly 210000.0000)\n`);

    async function due(asOf: Date, label: string) {
        const s = await svc.getDueStatus(CASE, asOf);
        const first = s.unpaidInstallments[0];
        console.log(`${asOf.toDateString().padEnd(20)} (${label.padEnd(40)}) tier=${first ? first.tier : '-'} penal=₹${first ? first.penalDue : 0} totalDue=₹${s.totalDue}`);
    }

    console.log('--- Tier boundaries for installment #10 (for July 2027), grace ends day 15 ---');
    await due(d(2027, 7, 1), 'day 1 — grace');
    await due(d(2027, 7, 15), 'day 15 — last day of grace');
    await due(d(2027, 7, 16), 'day 16 — tier 1 starts (flat fee)');
    await due(d(2027, 7, 31), 'day 31 — still tier 1, unchanged');
    await due(d(2027, 8, 1), 'Aug 1 — tier 2, 1 month overdue');
    await due(d(2027, 8, 31), 'Aug 31 — still 1 month, unchanged all month');
    await due(d(2027, 9, 1), 'Sep 1 — tier 2, 2 months overdue');

    console.log('\n--- Early closure quote on Sep 2 (current month folded in directly) ---');
    const quote = await svc.calculateEarlyClosure(CASE, d(2027, 9, 2));
    console.log(JSON.stringify(quote, null, 2));

    await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
    await AppDataSource.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
    console.log('\nTest loan removed.');
    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
