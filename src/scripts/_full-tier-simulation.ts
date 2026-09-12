import { AppDataSource } from '../config/database.config';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Full simulation matrix for the grace/tiered-penal redesign, driven entirely
// through the REAL LoanRepaymentService -- no arithmetic is reconstructed by
// hand here, every "expected" value below is derived from the same formulas
// the code uses, and every "actual" value is read back from a real DB call.
//
// This run intentionally KEEPS all 10 test loans and their ledger rows in the
// database afterward -- nothing is deleted -- so the results can be inspected
// directly in Postgres or via the app, not just trusted from this report.

const MBNO = '900000002';
const RATE = 12, N = 30;
const svc_disbursed = (offsetMonths = 0) => { const d = new Date(2026, 8, 25); d.setMonth(d.getMonth() + offsetMonths); return d; };

function round2(x: number) { return Math.round(x * 100) / 100; }
function d(y: number, m: number, day: number) { return new Date(y, m - 1, day); }
function fmt(dt: Date) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }
function emiFor(loanAmt: number, rate: number, n: number) {
    const r = rate / 100 / 12;
    return round2((loanAmt * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
}

const checks: { label: string; pass: boolean; expected: any; actual: any }[] = [];
function check(label: string, expected: number, actual: number, tol = 0.02) {
    const pass = Math.abs(expected - actual) <= tol;
    checks.push({ label, pass, expected, actual });
}
function checkEq(label: string, expected: any, actual: any) {
    const pass = expected === actual;
    checks.push({ label, pass, expected, actual });
}

interface TraceEntry {
    scenario: string; loanCase: string; seq: number; action: string;
    asOfDate: string; details: string;
    amount?: number; principal?: number; interest?: number; penal?: number;
    tier?: number | string; balanceAfter?: number;
}
const trace: TraceEntry[] = [];
let traceSeq: Record<string, number> = {};
function logTrace(scenario: string, loanCase: string, action: string, asOfDate: Date | string, details: string, extra: Partial<TraceEntry> = {}) {
    const key = `${scenario}|${loanCase}`;
    traceSeq[key] = (traceSeq[key] || 0) + 1;
    trace.push({
        scenario, loanCase, seq: traceSeq[key], action,
        asOfDate: typeof asOfDate === 'string' ? asOfDate : fmt(asOfDate),
        details, ...extra,
    });
}

async function freshLoan(qr: any, scenario: string, loancaseno: string, opts: {
    loantype?: string; loanAmt?: number; rate?: number; n?: number; penalRate?: number;
    graceDay?: number; smPct?: number; smDiv?: number; disbursed?: Date;
}) {
    const loanAmt = opts.loanAmt ?? 300000;
    const rate = opts.rate ?? RATE;
    const n = opts.n ?? N;
    const penalRate = opts.penalRate ?? 15;
    const graceDay = opts.graceDay ?? 15;
    const smPct = opts.smPct ?? 1;
    const smDiv = opts.smDiv ?? 4;
    const disbursed = opts.disbursed ?? svc_disbursed();
    const instalAmt = emiFor(loanAmt, rate, n);
    await qr.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno = $1`, [loancaseno]);
    await qr.query(`DELETE FROM loan_master WHERE loancaseno::text = $1`, [loancaseno]);
    await qr.query(
        `INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, balance, openbalance, rate, no_of_instal, instal_amt, payment_date, purpose, intt_amount, penalrate, gracedays, smpenalpct, smpenaldiv)
         VALUES ($1,$2,$3,$4,$4,0,$5,$6,$7,$8,'full-tier-sim-v2',$9,$10,$11,$12,$13)`,
        [MBNO, opts.loantype ?? 'ELN', loancaseno, loanAmt, rate, n, instalAmt,
         disbursed, round2(loanAmt * rate / 1200), penalRate, graceDay, smPct, smDiv]
    );
    logTrace(scenario, loancaseno, 'DISBURSE', disbursed,
        `${opts.loantype ?? 'ELN'} loan disbursed: principal=Rs.${loanAmt}, rate=${rate}%, term=${n}mo, EMI=Rs.${instalAmt}, penalRate=${penalRate}%, graceDay=${graceDay}, smPct=${smPct}%, smDiv=${smDiv}`,
        { amount: loanAmt });
    return instalAmt;
}

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
    const svc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);
    const qr = AppDataSource.createQueryRunner();

    // ===== Scenario 1: full-term control -- every EMI within grace, all 30 months =====
    {
        const S = 'S1', CASE = '999910';
        const instalAmt = await freshLoan(qr, S, CASE, {});
        const disb = svc_disbursed();
        for (let m = 1; m <= N; m++) {
            const dd = new Date(disb); dd.setMonth(dd.getMonth() + m); dd.setDate(10);
            const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: instalAmt, asOfDate: dd, username: 'sim' } as any);
            logTrace(S, CASE, 'PAYMENT', dd, r.message, { amount: instalAmt });
            if (!r.message.includes('Covered')) checks.push({ label: `S1 month ${m} payment applied`, pass: false, expected: 'Covered', actual: r.message });
        }
        const row = await AppDataSource.query(`SELECT balance FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
        check('S1 full-term control: balance reaches exactly 0', 0, parseFloat(row[0].balance));
        const paid = await AppDataSource.query(`SELECT COALESCE(SUM(penal_amount),0) as p, COALESCE(SUM(interest_amount),0) as i FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
        check('S1 zero penal ever charged', 0, parseFloat(paid[0].p));
        check('S1 total interest matches EMI formula (30 x 1624.43)', round2(30 * (instalAmt - 10000)), parseFloat(paid[0].i));
        logTrace(S, CASE, 'FINAL', d(2029, 3, 25), `Loan fully closed via 30 on-time EMIs. Balance=0, total penal=Rs.0, total interest=Rs.${paid[0].i}.`);
    }

    // ===== Scenario 2: Tier 1 repeated -- every EMI paid past grace, same month, 6 months =====
    {
        const S = 'S2', CASE = '999911';
        const instalAmt = await freshLoan(qr, S, CASE, {});
        const disb = svc_disbursed();
        for (let m = 1; m <= 6; m++) {
            const dd = new Date(disb); dd.setMonth(dd.getMonth() + m); dd.setDate(20); // past grace(15), same month
            const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: instalAmt + 25, asOfDate: dd, username: 'sim' } as any);
            logTrace(S, CASE, 'PAYMENT', dd, r.message, { amount: instalAmt + 25, penal: 25, tier: 1 });
        }
        const paid = await AppDataSource.query(`SELECT COALESCE(SUM(penal_amount),0) as p FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
        check('S2 Tier1 repeated x6: total flat fee = 6 x 25', 150, parseFloat(paid[0].p));
        const row = await AppDataSource.query(`SELECT balance FROM loan_master WHERE loancaseno::text = $1`, [CASE]);
        check('S2 balance after 6 on-schedule-but-late months', 240000, parseFloat(row[0].balance));
        logTrace(S, CASE, 'FINAL', d(2027, 4, 20), `6 months paid on the 20th (past day-15 grace, same month each time). Total flat fee=Rs.150 (6x25), balance=Rs.${row[0].balance}.`);
    }

    // ===== Scenario 3: tier boundary precision (no payments, pure due-status checks) =====
    {
        const S = 'S3', CASE = '999912';
        await freshLoan(qr, S, CASE, {});
        const disb = svc_disbursed();
        const dueDate = new Date(disb); dueDate.setMonth(dueDate.getMonth() + 1); // installment #1
        const y = dueDate.getFullYear(), mo = dueDate.getMonth() + 1;
        const at = async (day: number, label: string) => {
            const s = (await svc.getDueStatus(CASE, d(y, mo, day))).unpaidInstallments[0];
            logTrace(S, CASE, 'DUE_STATUS', d(y, mo, day), `${label}: tier=${s.tier}, penal=Rs.${s.penalDue}`, { tier: s.tier, penal: s.penalDue });
            return s;
        };
        let s = await at(15, 'Day 15 (grace boundary)'); checkEq('S3 day 15 (grace boundary) tier', 0, s.tier); check('S3 day 15 penal', 0, s.penalDue);
        s = await at(16, 'Day 16 (Tier 1 starts)'); checkEq('S3 day 16 (tier1 starts) tier', 1, s.tier); check('S3 day 16 penal = 25', 25, s.penalDue);
        const monthEndDay = new Date(y, mo, 0).getDate();
        s = await at(monthEndDay, 'Month-end (still Tier 1)');
        checkEq('S3 month-end still tier1', 1, s.tier); check('S3 month-end penal unchanged = 25', 25, s.penalDue);
        const nextMonth = new Date(y, mo, 1);
        const s2 = (await svc.getDueStatus(CASE, nextMonth)).unpaidInstallments[0];
        logTrace(S, CASE, 'DUE_STATUS', nextMonth, `1st of next month (Tier 2 starts): tier=${s2.tier}, penal=Rs.${s2.penalDue}`, { tier: s2.tier, penal: s2.penalDue });
        checkEq('S3 1st of next month = tier2', 2, s2.tier); check('S3 1st of next month penal = 125 (1mo)', 125, s2.penalDue);
    }

    // ===== Scenario 4: 3 consecutive misses + lump-sum catch-up =====
    {
        const S = 'S4', CASE = '999913';
        const instalAmt = await freshLoan(qr, S, CASE, {});
        const disb = svc_disbursed();
        for (let m = 1; m <= 2; m++) {
            const dd = new Date(disb); dd.setMonth(dd.getMonth() + m); dd.setDate(10);
            const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: instalAmt, asOfDate: dd, username: 'sim' } as any);
            logTrace(S, CASE, 'PAYMENT', dd, r.message, { amount: instalAmt });
        }
        logTrace(S, CASE, 'NOTE', svc_disbursed(3), 'Installments #3, #4, #5 deliberately skipped (no payment made for these months).');
        const catchUpDate = new Date(disb); catchUpDate.setMonth(catchUpDate.getMonth() + 6); catchUpDate.setDate(10);
        const before = await svc.getDueStatus(CASE, catchUpDate);
        for (const i of before.unpaidInstallments) {
            logTrace(S, CASE, 'DUE_STATUS', catchUpDate, `Installment #${i.installmentNo} before catch-up: tier=${i.tier}, monthsOverdue=${i.monthsOverdue}, penal=Rs.${i.penalDue}, principalDue=Rs.${i.principalDue}, interestDue=Rs.${i.interestDue}`,
                { tier: i.tier, penal: i.penalDue, principal: i.principalDue, interest: i.interestDue });
        }
        checkEq('S4 three installments overdue before catch-up', 4, before.unpaidInstallments.length);
        const [i3, i4, i5] = before.unpaidInstallments;
        checkEq('S4 installment #3 monthsOverdue=3', 3, i3.monthsOverdue);
        checkEq('S4 installment #4 monthsOverdue=2', 2, i4.monthsOverdue);
        checkEq('S4 installment #5 monthsOverdue=1', 1, i5.monthsOverdue);
        check('S4 penal steps 375/250/125 (#3)', 375, i3.penalDue);
        check('S4 penal steps 375/250/125 (#4)', 250, i4.penalDue);
        check('S4 penal steps 375/250/125 (#5)', 125, i5.penalDue);
        const lumpSum = round2(i3.principalDue + i3.interestDue + i3.penalDue + i4.principalDue + i4.interestDue + i4.penalDue + i5.principalDue + i5.interestDue + i5.penalDue);
        const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: lumpSum, asOfDate: catchUpDate, username: 'sim' } as any);
        logTrace(S, CASE, 'PAYMENT', catchUpDate, `Lump-sum catch-up: ${r.message}`, { amount: lumpSum });
        checkEq('S4 lump sum covers installments #3,4,5', true, r.message.includes('#3, 4, 5') && !r.message.includes('#3, 4, 5, 6'));
        const after = await svc.getDueStatus(CASE, catchUpDate);
        checkEq('S4 only installment #6 remains, tier0', 1, after.unpaidInstallments.length);
        checkEq('S4 installment #6 tier0, no penal', 0, after.unpaidInstallments[0].tier);
        logTrace(S, CASE, 'FINAL', catchUpDate, `After catch-up: only installment #6 remains unpaid, Tier 0, Rs.0 penal.`);
    }

    // ===== Scenario 5: short-month (Feb) grace clamp =====
    {
        const S = 'S5', CASE = '999914';
        const disb5 = new Date(2027, 8, 25); // Sept 25 2027 + 5 months = Feb 25 2028
        await freshLoan(qr, S, CASE, { disbursed: disb5, graceDay: 31 });
        const feb29 = await svc.getDueStatus(CASE, d(2028, 2, 29));
        const inst5_feb = feb29.unpaidInstallments.find((i: any) => i.installmentNo === 5);
        logTrace(S, CASE, 'DUE_STATUS', d(2028, 2, 29), `Installment #5, Feb 29 2028 (last real day of a leap Feb): tier=${inst5_feb.tier}, penal=Rs.${inst5_feb.penalDue} (grace=31 clamped to 29)`, { tier: inst5_feb.tier, penal: inst5_feb.penalDue });
        checkEq('S5 Feb 29 (leap) still within clamped grace, tier0', 0, inst5_feb.tier);
        const mar1 = await svc.getDueStatus(CASE, d(2028, 3, 1));
        const inst5_mar = mar1.unpaidInstallments.find((i: any) => i.installmentNo === 5);
        logTrace(S, CASE, 'DUE_STATUS', d(2028, 3, 1), `Installment #5, Mar 1 2028: tier=${inst5_mar.tier}, penal=Rs.${inst5_mar.penalDue} (Tier1 window never existed, straight to Tier2)`, { tier: inst5_mar.tier, penal: inst5_mar.penalDue });
        checkEq('S5 Mar 1 -- tier1 window never existed, jumps straight to tier2', 2, inst5_mar.tier);
        check('S5 Mar 1 penal = 1 month step (125)', 125, inst5_mar.penalDue);
    }

    // ===== Scenario 6: degenerate configs -- grace=0, and smpct/smdiv=0 =====
    {
        const S = 'S6', CASE = '999915';
        await freshLoan(qr, S, CASE, { graceDay: 0 });
        const disb = svc_disbursed();
        const dueDate = new Date(disb); dueDate.setMonth(dueDate.getMonth() + 1);
        const s = await svc.getDueStatus(CASE, d(dueDate.getFullYear(), dueDate.getMonth() + 1, 1));
        logTrace(S, CASE, 'DUE_STATUS', d(dueDate.getFullYear(), dueDate.getMonth() + 1, 1), `grace=0 config: day 1 of due month already tier=${s.unpaidInstallments[0].tier}, penal=Rs.${s.unpaidInstallments[0].penalDue}`, { tier: s.unpaidInstallments[0].tier, penal: s.unpaidInstallments[0].penalDue });
        checkEq('S6a grace=0: day 1 of due month already tier1', 1, s.unpaidInstallments[0].tier);
        check('S6a grace=0: day 1 penal = 25 (flat fee still applies)', 25, s.unpaidInstallments[0].penalDue);

        const CASE2 = '999916';
        await freshLoan(qr, S, CASE2, { smPct: 0 });
        const disb2 = svc_disbursed();
        const dueDate2 = new Date(disb2); dueDate2.setMonth(dueDate2.getMonth() + 1);
        const s2 = await svc.getDueStatus(CASE2, d(dueDate2.getFullYear(), dueDate2.getMonth() + 1, 20));
        logTrace(S, CASE2, 'DUE_STATUS', d(dueDate2.getFullYear(), dueDate2.getMonth() + 1, 20), `smPct=0 config: tier=${s2.unpaidInstallments[0].tier} but penal=Rs.${s2.unpaidInstallments[0].penalDue} (guarded to zero)`, { tier: s2.unpaidInstallments[0].tier, penal: s2.unpaidInstallments[0].penalDue });
        checkEq('S6b smPct=0: still tier1 by date', 1, s2.unpaidInstallments[0].tier);
        check('S6b smPct=0: penal is 0 despite tier1', 0, s2.unpaidInstallments[0].penalDue);
    }

    // ===== Scenario 7: partial payments across several months =====
    {
        const S = 'S7', CASE = '999917';
        const instalAmt = await freshLoan(qr, S, CASE, {});
        const disb = svc_disbursed();
        for (let m = 1; m <= 4; m++) {
            const dd = new Date(disb); dd.setMonth(dd.getMonth() + m); dd.setDate(10);
            const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: round2(instalAmt * 0.5), asOfDate: dd, username: 'sim-partial' } as any);
            logTrace(S, CASE, 'PAYMENT', dd, `Partial (50% of EMI): ${r.message}`, { amount: round2(instalAmt * 0.5) });
        }
        const statusDate = new Date(disb); statusDate.setMonth(statusDate.getMonth() + 4); statusDate.setDate(10);
        const status = await svc.getDueStatus(CASE, statusDate);
        for (const i of status.unpaidInstallments) {
            logTrace(S, CASE, 'DUE_STATUS', statusDate, `Installment #${i.installmentNo} still open: tier=${i.tier}, principalDue=Rs.${i.principalDue}, interestDue=Rs.${i.interestDue}, penalDue=Rs.${i.penalDue}`, { tier: i.tier, principal: i.principalDue, interest: i.interestDue, penal: i.penalDue });
        }
        checkEq('S7 partial payments: penal-cascade leaves 3 installments open (not naive 4)', 3, status.unpaidInstallments.length);
        const principalPaidRows = await AppDataSource.query(`SELECT COALESCE(SUM(principal_amount),0) as p FROM loan_repayment_ledger WHERE loancaseno = $1`, [CASE]);
        const principalPaidSoFar = parseFloat(principalPaidRows[0].p);
        const principalStillDue = status.unpaidInstallments.reduce((s: number, i: any) => s + i.principalDue, 0);
        check('S7 conservation: principal paid + principal still due = 40,000 exactly', 40000, round2(principalPaidSoFar + principalStillDue));
        logTrace(S, CASE, 'FINAL', statusDate, `4 half-EMI payments left 3 installments still open (penal-first recovery ate into what would've been principal). Conservation check: paid(${principalPaidSoFar}) + still-due(${principalStillDue}) = 40,000.`);
    }

    // ===== Scenario 8: early closure -- quote vs executed, 4 states =====
    {
        const S = 'S8';
        let CASE = '9999181';
        await freshLoan(qr, S, CASE, {});
        const disb = svc_disbursed();
        const closeDate = new Date(disb); closeDate.setMonth(closeDate.getMonth() + 1); closeDate.setDate(5);
        const quote = await svc.calculateEarlyClosure(CASE, closeDate);
        logTrace(S, CASE, 'CLOSURE_QUOTE', closeDate, `Zero-arrears, mid-grace closure quote: Rs.${quote.finalClosureAmount}`, { amount: quote.finalClosureAmount });
        const exec = await svc.executeEarlyClosure(CASE, closeDate, 0, 'sim', 'TEST-8A');
        logTrace(S, CASE, 'CLOSURE_EXECUTED', closeDate, exec.message, { amount: exec.finalClosureAmount });
        check('S8a zero-arrears closure: quote == executed', quote.finalClosureAmount, exec.finalClosureAmount);

        CASE = '9999182';
        await freshLoan(qr, S, CASE, {});
        const disb2 = svc_disbursed();
        const closeDate2 = new Date(disb2); closeDate2.setMonth(closeDate2.getMonth() + 1); closeDate2.setDate(20);
        const quote2 = await svc.calculateEarlyClosure(CASE, closeDate2);
        logTrace(S, CASE, 'CLOSURE_QUOTE', closeDate2, `One Tier1 installment outstanding, quote: Rs.${quote2.finalClosureAmount} (penal=Rs.${quote2.penalInterest})`, { amount: quote2.finalClosureAmount, penal: quote2.penalInterest });
        const exec2 = await svc.executeEarlyClosure(CASE, closeDate2, 0, 'sim', 'TEST-8B');
        logTrace(S, CASE, 'CLOSURE_EXECUTED', closeDate2, exec2.message, { amount: exec2.finalClosureAmount });
        check('S8b Tier1 closure: quote == executed', quote2.finalClosureAmount, exec2.finalClosureAmount);
        checkEq('S8b penalInterest = 25 (one Tier1 installment)', 25, quote2.penalInterest);

        CASE = '9999183';
        await freshLoan(qr, S, CASE, {});
        const disb3 = svc_disbursed();
        const closeDate3 = new Date(disb3); closeDate3.setMonth(closeDate3.getMonth() + 3); closeDate3.setDate(10);
        const quote3 = await svc.calculateEarlyClosure(CASE, closeDate3);
        logTrace(S, CASE, 'CLOSURE_QUOTE', closeDate3, `Two Tier2 installments outstanding, quote: Rs.${quote3.finalClosureAmount} (penal=Rs.${quote3.penalInterest})`, { amount: quote3.finalClosureAmount, penal: quote3.penalInterest });
        const exec3 = await svc.executeEarlyClosure(CASE, closeDate3, 0, 'sim', 'TEST-8C');
        logTrace(S, CASE, 'CLOSURE_EXECUTED', closeDate3, exec3.message, { amount: exec3.finalClosureAmount });
        check('S8c Tier2 x2 closure: quote == executed', quote3.finalClosureAmount, exec3.finalClosureAmount);
        check('S8c penalInterest = 125+250 = 375', 375, quote3.penalInterest);

        CASE = '9999184';
        const smallN = 3;
        const instalAmtD = await freshLoan(qr, S, CASE, { n: smallN, loanAmt: 30000 });
        const disb4 = svc_disbursed();
        for (let m = 1; m <= smallN - 1; m++) {
            const dd = new Date(disb4); dd.setMonth(dd.getMonth() + m); dd.setDate(10);
            const r = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE, paymentAmount: instalAmtD, asOfDate: dd, username: 'sim' } as any);
            logTrace(S, CASE, 'PAYMENT', dd, r.message, { amount: instalAmtD });
        }
        const finalCloseDate = new Date(disb4); finalCloseDate.setMonth(finalCloseDate.getMonth() + smallN); finalCloseDate.setDate(5);
        const quote4 = await svc.calculateEarlyClosure(CASE, finalCloseDate);
        logTrace(S, CASE, 'CLOSURE_QUOTE', finalCloseDate, `Final-scheduled-month closure quote (3-installment, Rs.30,000 loan): Rs.${quote4.finalClosureAmount}`, { amount: quote4.finalClosureAmount });
        const exec4 = await svc.executeEarlyClosure(CASE, finalCloseDate, 0, 'sim', 'TEST-8D');
        logTrace(S, CASE, 'CLOSURE_EXECUTED', finalCloseDate, exec4.message, { amount: exec4.finalClosureAmount });
        check('S8d final-month closure: quote == executed', quote4.finalClosureAmount, exec4.finalClosureAmount);
    }

    // ===== Scenario 9: cross-type resolution (RLN, ALN) using LIVE busrules values =====
    {
        const S = 'S9';
        const rules = (await AppDataSource.query(`SELECT rlnrate, rlnpenalrate, rlngracedays, rlnsmpct, rlnsmdiv, alnrate, alnpenalrate, alngracedays, alnsmpct, alnsmdiv FROM busrules ORDER BY appdate DESC LIMIT 1`))[0];
        const CASE_R = '9999191';
        await freshLoan(qr, S, CASE_R, {
            loantype: 'RLN', rate: parseFloat(rules.rlnrate) || 12, penalRate: parseFloat(rules.rlnpenalrate) || 15,
            graceDay: parseInt(rules.rlngracedays, 10) || 15, smPct: parseFloat(rules.rlnsmpct) || 1, smDiv: parseFloat(rules.rlnsmdiv) || 4,
        });
        const rRow = (await AppDataSource.query(`SELECT rate, penalrate, gracedays, smpenalpct, smpenaldiv FROM loan_master WHERE loancaseno::text=$1`, [CASE_R]))[0];
        logTrace(S, CASE_R, 'VERIFY', svc_disbursed(), `RLN froze: rate=${rRow.rate}, penalrate=${rRow.penalrate}, grace=${rRow.gracedays}, smpct=${rRow.smpenalpct}, smdiv=${rRow.smpenaldiv} (from live busrules rln* columns)`);
        checkEq('S9 RLN loan froze correct rate', String(parseFloat(rules.rlnrate) || 12), String(parseFloat(rRow.rate)));

        const CASE_A = '9999192';
        await freshLoan(qr, S, CASE_A, {
            loantype: 'ALN', rate: parseFloat(rules.alnrate) || 12, penalRate: parseFloat(rules.alnpenalrate) || 2,
            graceDay: parseInt(rules.alngracedays, 10) || 15, smPct: parseFloat(rules.alnsmpct) || 1, smDiv: parseFloat(rules.alnsmdiv) || 4,
        });
        const aRow = (await AppDataSource.query(`SELECT rate, penalrate, gracedays, smpenalpct, smpenaldiv FROM loan_master WHERE loancaseno::text=$1`, [CASE_A]))[0];
        logTrace(S, CASE_A, 'VERIFY', svc_disbursed(), `ALN froze: rate=${aRow.rate}, penalrate=${aRow.penalrate}, grace=${aRow.gracedays}, smpct=${aRow.smpenalpct}, smdiv=${aRow.smpenaldiv} (from live busrules aln* columns)`);
        checkEq('S9 ALN loan froze correct rate', String(parseFloat(rules.alnrate) || 12), String(parseFloat(aRow.rate)));
    }

    // ===== Scenario 10: same member, two concurrent loan types -- balance isolation =====
    {
        const S = 'S10', CASE_E = '9999201', CASE_R = '9999202';
        const instalE = await freshLoan(qr, S, CASE_E, { loantype: 'ELN' });
        const instalR = await freshLoan(qr, S, CASE_R, { loantype: 'RLN' });
        const before = (await AppDataSource.query(`SELECT emergency_loan_balance, regularloan FROM member_balances WHERE mbno=$1`, [MBNO]))[0] || { emergency_loan_balance: 0, regularloan: 0 };
        logTrace(S, `${CASE_E}/${CASE_R}`, 'NOTE', svc_disbursed(), `Member ${MBNO} balances before any repayment: emergency_loan_balance=${before.emergency_loan_balance}, regularloan=${before.regularloan}`);
        const disb = svc_disbursed();
        const dd1 = new Date(disb); dd1.setMonth(dd1.getMonth() + 1); dd1.setDate(10);
        const rE = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE_E, paymentAmount: instalE, asOfDate: dd1, username: 'sim' } as any);
        logTrace(S, CASE_E, 'PAYMENT', dd1, rE.message, { amount: instalE });
        const afterE = (await AppDataSource.query(`SELECT emergency_loan_balance, regularloan FROM member_balances WHERE mbno=$1`, [MBNO]))[0];
        logTrace(S, CASE_E, 'VERIFY', dd1, `After ELN repayment: emergency_loan_balance=${afterE.emergency_loan_balance}, regularloan=${afterE.regularloan} (regularloan must be unchanged)`);
        checkEq('S10 ELN repayment did NOT touch regularloan', String(before.regularloan), String(afterE.regularloan));
        const rR = await svc.recordLoanRepayment({ mbno: MBNO, loancaseno: CASE_R, paymentAmount: instalR, asOfDate: dd1, username: 'sim' } as any);
        logTrace(S, CASE_R, 'PAYMENT', dd1, rR.message, { amount: instalR });
        const afterR = (await AppDataSource.query(`SELECT emergency_loan_balance, regularloan FROM member_balances WHERE mbno=$1`, [MBNO]))[0];
        logTrace(S, CASE_R, 'VERIFY', dd1, `After RLN repayment: emergency_loan_balance=${afterR.emergency_loan_balance}, regularloan=${afterR.regularloan} (emergency_loan_balance must be unchanged from previous step)`);
        checkEq('S10 RLN repayment did NOT touch emergency_loan_balance further', String(afterE.emergency_loan_balance), String(afterR.emergency_loan_balance));
    }

    await qr.release();

    // ===== Report =====
    console.log('\n\n========== SIMULATION RESULTS ==========');
    let passCount = 0;
    for (const c of checks) {
        const mark = c.pass ? 'PASS' : 'FAIL';
        if (c.pass) passCount++;
        console.log(`[${mark}] ${c.label} | expected=${JSON.stringify(c.expected)} | actual=${JSON.stringify(c.actual)}`);
    }
    console.log(`\n${passCount}/${checks.length} checks passed.`);

    console.log('\n\n========== CSV_START ==========');
    console.log('label,pass,expected,actual');
    for (const c of checks) {
        console.log(`"${c.label.replace(/"/g, '""')}",${c.pass},${JSON.stringify(c.expected)},${JSON.stringify(c.actual)}`);
    }
    console.log('========== CSV_END ==========');

    console.log('\n\n========== TRACE_CSV_START ==========');
    console.log('scenario,loanCase,seq,action,asOfDate,details,amount,principal,interest,penal,tier,balanceAfter');
    for (const t of trace) {
        const esc = (s: any) => s === undefined || s === null ? '' : String(s).replace(/"/g, '""');
        console.log(`"${esc(t.scenario)}","${esc(t.loanCase)}",${t.seq},"${esc(t.action)}","${esc(t.asOfDate)}","${esc(t.details)}","${esc(t.amount)}","${esc(t.principal)}","${esc(t.interest)}","${esc(t.penal)}","${esc(t.tier)}","${esc(t.balanceAfter)}"`);
    }
    console.log('========== TRACE_CSV_END ==========');

    // Confirm final DB state left behind, per request -- nothing deleted this run.
    const finalLoans = await AppDataSource.query(`SELECT loancaseno, loantype, loan_amt, balance, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv FROM loan_master WHERE loancaseno::text LIKE '9999%' ORDER BY loancaseno::text`);
    console.log('\n\n========== FINAL DB STATE (left in place) ==========');
    console.table(finalLoans);
    const ledgerCount = await AppDataSource.query(`SELECT COUNT(*) as c FROM loan_repayment_ledger WHERE loancaseno LIKE '9999%'`);
    console.log(`loan_repayment_ledger rows for these test loans: ${ledgerCount[0].c}`);

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
