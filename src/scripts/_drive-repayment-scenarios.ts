// Drives the 4 test loans through their scenarios using the REAL
// LoanRepaymentService — only its dataSource dependency, no full app boot
// needed (that's what made the earlier attempt take 30+ minutes). The
// asOfDate override lets us simulate a year passing without waiting for it.
import { AppDataSource } from '../config/database.config';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const MBNO = '940000002';
const LOAN_A = '888969'; // 150000/14mo — heavy long-overdue, multi-installment penal
const LOAN_B = '888970'; // 90000/14mo — on-time then one miss + catch-up
const LOAN_C = '888971'; // 80000/12mo — miss + partial payment + early closure
const LOAN_D = '888972'; // 40000/10mo — on-time + prepayment, stays open

function d(s: string): Date { return new Date(s); }

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const svc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);

    async function pay(loancaseno: string, amount: number, asOfDate: Date, narration: string) {
        const r = await svc.recordLoanRepayment({
            mbno: MBNO, loancaseno, paymentAmount: amount, asOfDate,
            narration, username: 'test-script',
        } as any);
        console.log(`  [${loancaseno} @ ${asOfDate.toISOString().slice(0, 10)}] ₹${amount} — ${r.message}`);
    }

    async function due(loancaseno: string, asOfDate: Date, label: string) {
        const status = await svc.getDueStatus(loancaseno, asOfDate);
        console.log(`  [${loancaseno} DUE STATUS @ ${asOfDate.toISOString().slice(0, 10)}] (${label})`);
        console.log(`    unpaid installments: ${status.unpaidInstallments.length}, totalDue: ₹${status.totalDue} (P:${status.totalPrincipalDue} I:${status.totalInterestDue} Penal:${status.totalPenalDue})`);
        if (status.unpaidInstallments.length > 0) {
            console.log('    ', status.unpaidInstallments.map((i: any) => `#${i.installmentNo}(${i.monthsOverdue}mo,pen₹${i.penalDue})`).join(' '));
        }
    }

    console.log('\n=== LOAN A (888969) — heavy long-overdue, no payments until month 8 ===');
    await due(LOAN_A, d('2027-04-20'), 'before any payment, ~8 months elapsed');
    await pay(LOAN_A, 60000, d('2027-04-20'), 'Large catch-up payment');
    await due(LOAN_A, d('2027-04-20'), 'after partial catch-up');

    console.log('\n=== LOAN B (888970) — on-time x3, miss 1, catch-up ===');
    await pay(LOAN_B, 6921.11, d('2026-09-13'), 'On-time installment 1');
    await pay(LOAN_B, 6921.11, d('2026-10-13'), 'On-time installment 2');
    await pay(LOAN_B, 6921.11, d('2026-11-13'), 'On-time installment 3');
    // installment 4 (due 2026-12-13) deliberately skipped
    await due(LOAN_B, d('2027-01-20'), 'after missing installment 4');
    await pay(LOAN_B, 13842.22, d('2027-01-20'), 'Catch-up covering installments 4 and 5');
    await due(LOAN_B, d('2027-01-20'), 'after catch-up — should be current');

    console.log('\n=== LOAN C (888971) — on-time x3, miss 2, partial payment, early closure ===');
    await pay(LOAN_C, 7107.90, d('2026-09-13'), 'On-time installment 1');
    await pay(LOAN_C, 7107.90, d('2026-10-13'), 'On-time installment 2');
    await pay(LOAN_C, 7107.90, d('2026-11-13'), 'On-time installment 3');
    // installments 4 (2026-12-13) and 5 (2027-01-13) deliberately skipped
    await due(LOAN_C, d('2027-02-20'), 'after missing 2 installments');
    await pay(LOAN_C, 10000, d('2027-02-20'), 'Partial payment — less than full due');
    await due(LOAN_C, d('2027-02-20'), 'after partial payment');

    console.log('  --- Early closure quote ---');
    const quote = await svc.calculateEarlyClosure(LOAN_C, d('2027-03-15'));
    console.log('  Quote:', JSON.stringify({
        outstandingPrincipal: quote.outstandingPrincipal,
        actualInterestToDate: quote.actualInterestToDate,
        previousOverdueInterest: quote.previousOverdueInterest,
        penalInterest: quote.penalInterest,
        finalClosureAmount: quote.finalClosureAmount,
    }));
    const closure = await svc.executeEarlyClosure(LOAN_C, d('2027-03-15'), 0, 'test-script', 'TEST-CLOSURE-C');
    console.log('  Executed:', closure.message);
    await due(LOAN_C, d('2027-03-15'), 'after early closure — should be empty');

    console.log('\n=== LOAN D (888972) — on-time, then prepayment, stays open ===');
    await pay(LOAN_D, 4223.28, d('2026-09-13'), 'On-time installment 1');
    await pay(LOAN_D, 9223.28, d('2026-10-13'), 'Installment 2 + ₹5000 advance principal');
    await due(LOAN_D, d('2026-11-20'), 'after prepayment, installment 3 now due');

    console.log('\n=== FINAL STATE ===');
    const rows = await AppDataSource.query(
        `SELECT loancaseno, loan_amt, balance, no_of_instal FROM loan_master WHERE loancaseno IN ($1,$2,$3,$4) ORDER BY loancaseno`,
        [LOAN_A, LOAN_B, LOAN_C, LOAN_D]
    );
    console.table(rows);

    await AppDataSource.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
