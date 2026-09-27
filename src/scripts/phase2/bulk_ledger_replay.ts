/**
 * Phase 2 — bulk ledger-replay migration.
 *
 * Problem: the earlier full legacy->Postgres migration imported every real
 * member's loan ORIGINATION details (loan_amt, instal_amt, no_of_instal,
 * rate) but never replayed their actual repayment history. As a result
 * 19,957 of 19,992 real loans sit at balance == loan_amt, as if the member
 * never paid a single EMI, regardless of how many years of real payments
 * they've actually made. Phase 0 scanning (this session, 2026-09-20/21)
 * found 3,643 of 6,644 real members actually have repayment history in the
 * legacy LEDGER that needs to be replayed; ~207 of those also have a real
 * loan-consolidation event (an old loan topped up into / closed by a new
 * one) that needs special handling, found via 261 clean matched-amount
 * journal-transfer pairs.
 *
 * This script replays that real history through the app's OWN production
 * services (LoanRepaymentService.recordLoanRepayment), not a hand-computed
 * shortcut — so a migrated loan behaves identically to one entered live
 * (same drift/rounding/penalty-tier/future-prepayment behavior) and there
 * is no special-cased "migrated" logic to diverge from normal loans later.
 *
 * SAFETY MODEL — READ BEFORE RUNNING:
 *   - DRY_RUN defaults to true. In dry-run, nothing is written to Postgres
 *     at all (not even the batch-log table) — every planned action is
 *     printed and summarized only.
 *   - To actually write, you must pass BOTH `DRY_RUN=false` AND
 *     `CONFIRM_LIVE_RUN=yes-i-mean-it` as env vars. Either one missing
 *     falls back to dry-run. This script does not run itself; it must be
 *     invoked explicitly via ts-node by a human who has reviewed the
 *     dry-run output first.
 *   - Each member is processed in its own DB transaction: a member either
 *     fully migrates or fully rolls back, never partial.
 *   - Legacy data is read via `sqlcmd` (no mssql/tedious driver is
 *     installed in this project — every legacy query this whole session
 *     has gone through sqlcmd, so this keeps that one proven access path
 *     instead of adding a new dependency unprompted).
 *   - loancaseno is NOT unique across mbno in this database (a real
 *     collision was hit and fixed earlier this session) — every query and
 *     update in this script filters on (mbno, loancaseno) together, never
 *     loancaseno alone.
 *   - Resumable via legacy_replay_batch_log (migration
 *     1759100000000-AddLegacyReplayBatchLog.ts, NOT yet applied — apply it
 *     before a live run) — a member already marked 'done' is skipped on
 *     re-run.
 *   - MBNO_FILTER env var restricts to a single member for a manual
 *     spot-check run before ever doing a full batch.
 *
 * Consolidation schedule reconstruction: each detected event starts a new
 * schedule version. Its fixed principal EMI is taken from the first actual
 * repayment in the eligible post-slot-delay period; the opening balance is
 * the cumulative loan principal at that boundary less every principal amount
 * recovered before the new schedule starts. A predecessor payroll-lag row is
 * excluded from the successor installment count, but its principal still
 * reduces the balance carried into consolidation. The old schedule and its
 * repayments remain in history.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../../modules/rd/services/rd-balance-events.service';
import { DEFAULT_SLOT1_END_DAY, DEFAULT_SLOT1_START_DAY, determineLoanSlot } from '../../modules/loan/services-v2/loan-rb-schedule.util';
import { isSlotDelayPayroll, selectFirstRecurringPrincipal } from './schedule-seed.util';
import { partitionReplayReceiptCopies } from './replay-receipt.util';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

const DRY_RUN = !(process.env.DRY_RUN === 'false' && process.env.CONFIRM_LIVE_RUN === 'yes-i-mean-it');
const MBNO_FILTER = process.env.MBNO_FILTER; // e.g. '610033146' or a comma list, to test specific members
// MBNO_FILE: a pinned, reviewed member list (one mbno per line) — preferred over a giant
// MBNO_FILTER env string for a real batch, so the run is auditable against exactly what
// was reviewed in the preceding dry-run pass rather than re-deriving "clean" live.
const MBNO_FILE = process.env.MBNO_FILE;
// Set only for a reviewed repair run: completed members are re-evaluated so
// derived schedules and payroll-lag classifications can be corrected. Exact
// source receipts remain idempotent and are not inserted a second time.
const REPLAY_COMPLETED = process.env.REPLAY_COMPLETED === 'true';
const MEMBER_LIMIT = process.env.MEMBER_LIMIT ? parseInt(process.env.MEMBER_LIMIT, 10) : undefined;
const BALANCE_TOLERANCE = 50; // rupees; mismatch beyond this is flagged, not silently accepted
const MIN_CONSOLIDATION_AMOUNT = 50; // rupees; matched journal pairs below this are noise (rounding vouchers), not real consolidations
const SQLCMD_SERVER = '.\\SQLEXPRESS';
const SQLCMD_DB = 'EMP_Espat_Society_dan';
let slotRuleConfig = { slot1DelayMonths: 1, slot2DelayMonths: 2, slot1StartDay: DEFAULT_SLOT1_START_DAY, slot1EndDay: DEFAULT_SLOT1_END_DAY };

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

// ---------------------------------------------------------------------
// Legacy extraction (via sqlcmd — no live mssql driver in this project)
// ---------------------------------------------------------------------

function sqlcmd(query: string): string[][] {
    const out = execFileSync('sqlcmd', [
        '-S', SQLCMD_SERVER, '-d', SQLCMD_DB, '-E', '-W', '-s', '|', '-h', '-1', '-Q', query,
    ], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 });
    return out.split('\n')
        .map(l => l.trimEnd())
        .filter(l => l.length > 0 && !/^-+(\|-+)*$/.test(l) && !/^\(\d+ rows? affected\)$/.test(l))
        .map(l => l.split('|').map(c => c.trim()));
}

interface LegacyCase {
    loancaseno: string;
    loantype: 'RLN' | 'ALN' | string;
    loanAmt: number;
    balance: number; // stale, informational only
    noOfInstal: number;
    instalAmt: number;
    paymentDate: string; // origination date
}

interface LegacyEvent {
    transNo: string;
    transDate: string;
    transType: 'CR' | 'DR';
    accType: 'RLN' | 'ALN';
    /** Principal only — this is what the FIFO/exhaustion attribution math in
     *  buildAttribution runs on to decide when a case's principal is used up.
     *  Must NEVER include interest, or a case looks exhausted earlier than
     *  its real principal balance says it should be. */
    amt: number;
    /** The matched I1002 interest leg for this same repayment, if any (see
     *  getLegacyEvents). Kept separate from `amt` for exactly the reason
     *  above; folded back in only when building what actually gets sent to
     *  recordLoanRepayment(), proportional to however much of `amt` a given
     *  case actually absorbed. */
    interestAmt: number;
    interestAllocationWarning?: string;
    interestAllocationInfo?: string;
    receiptVchrNo: string;
    vchrType: string;
    /** Raw PL_BALANCE from the ledger row — only ever meaningfully populated on
     *  a DR/'P' disbursement row (blank/zero on ordinary CR repayments, confirmed
     *  across the whole DB). See findPvoucherConsolidations for what it's used for. */
    plBalance?: number;
}

interface ConsolidationEvent {
    date: string;
    receiptVchrNo: string;
    amt: number;
    /** The case being paid down/closed — the CR leg (a CR on a loan head reduces
     *  its balance, same convention as an ordinary demand-receipt repayment). */
    fromHead: 'RLN' | 'ALN';
    /** The case being topped up — the DR leg (a DR on a loan head increases its
     *  balance, same convention as an ordinary disbursement). */
    toHead: 'RLN' | 'ALN';
    /** transNo of the CR leg, so its amount isn't also replayed as an ordinary
     *  repayment on top of being consumed here as the closing event. */
    crTransNo: string;
    /** Filled in during attribution, for audit logging only. */
    resolvedFromCase?: string;
    resolvedToCase?: string;
}

function getMembersInScope(): string[] {
    let query = `
        SET NOCOUNT ON;
        SELECT DISTINCT MBNO FROM LEDGER
        WHERE ACC_TYPE IN ('RLN','ALN') AND TRANS_TYPE='CR'
          AND MBNO NOT IN ('0')
        ORDER BY MBNO;
    `;
    const rows = sqlcmd(query);
    let members = rows.map(r => r[0]).filter(Boolean);
    if (MBNO_FILE) {
        const wanted = new Set(readFileSync(MBNO_FILE, 'utf-8').split(/\r?\n/).map(m => m.trim()).filter(Boolean));
        members = members.filter(m => wanted.has(m));
        console.log(`MBNO_FILE pinned list: ${wanted.size} members requested, ${members.length} matched current scope`);
    } else if (MBNO_FILTER) {
        const wanted = new Set(MBNO_FILTER.split(',').map(m => m.trim()).filter(Boolean));
        members = members.filter(m => wanted.has(m));
    }
    if (MEMBER_LIMIT) members = members.slice(0, MEMBER_LIMIT);
    return members;
}

function assertSafeMbno(mbno: string): void {
    if (!/^[0-9]{1,20}$/.test(mbno)) {
        throw new Error(`Refusing to interpolate suspicious MBNO into SQL: ${JSON.stringify(mbno)}`);
    }
}

function getLegacyCases(mbno: string): LegacyCase[] {
    assertSafeMbno(mbno);
    const rows = sqlcmd(`
        SET NOCOUNT ON;
        SELECT LOANCASENO, LOANTYPE, LOAN_AMT, BALANCE, NO_OF_INSTAL, INSTAL_AMT, CONVERT(varchar, PAYMENT_DATE, 120)
        FROM LOAN_MASTER WHERE MBNO='${mbno}' AND LOANTYPE IN ('RLN','ALN')
        ORDER BY PAYMENT_DATE;
    `);
    return rows.map(r => ({
        loancaseno: r[0], loantype: r[1] as any,
        loanAmt: parseFloat(r[2]), balance: parseFloat(r[3]),
        noOfInstal: parseInt(r[4], 10), instalAmt: parseFloat(r[5]),
        paymentDate: r[6],
    }));
}

/** Legacy split every real repayment into TWO ledger legs, not one: the
 *  principal under ACC_TYPE RLN/ALN (what getLegacyEvents' main query reads)
 *  and the interest under a completely separate CODE='I1002' (ACC_TYPE='OTH')
 *  leg, same date, same RECEIPT_VCHR_NO. Confirmed at scale across the whole
 *  DB (2026-09-21 investigation): 65.6% of real legacy loans (8,197 of
 *  12,501) show an INSTAL_AMT with essentially zero embedded interest even
 *  though their own RATE field says 12% — not because they were interest-
 *  free, but because the interest was never folded into INSTAL_AMT in the
 *  first place. The I1002/OTH leg carries it instead: 121,421 of 122,086
 *  "Demand Receipt"-narrated I1002 rows (99.5%) and 19,649 of 20,872
 *  blank-narration ones (94.2%) match a same-date/same-voucher RLN or ALN
 *  leg for the same member, across 3,682 distinct members — this is a
 *  structural legacy accounting pattern, not noise. Without this, replay
 *  only ever recovers the principal-only slice of a real payment, which is
 *  exactly why AP closure interest came out nonsensical (even negative) on
 *  migrated loans: the "frozen EMI" the app inherited never had real
 *  interest in it to begin with. */
function getLegacyInterestLegs(mbno: string): {
    transDate: string; receiptVchrNo: string; amt: number;
}[] {
    assertSafeMbno(mbno);
    const rows = sqlcmd(`
        SET NOCOUNT ON;
        SELECT CONVERT(varchar, TRANS_DATE, 120), RECEIPT_VCHR_NO, TRANS_AMT
        FROM LEDGER WHERE MBNO='${mbno}' AND CODE='I1002' AND TRANS_TYPE='CR'
        ORDER BY TRANS_DATE;
    `);
    return rows.map(r => ({ transDate: r[0], receiptVchrNo: r[1], amt: parseFloat(r[2]) }));
}

function getLegacyEvents(mbno: string): LegacyEvent[] {
    assertSafeMbno(mbno);
    const rows = sqlcmd(`
        SET NOCOUNT ON;
        SELECT TRANS_NO, CONVERT(varchar, TRANS_DATE, 120), TRANS_TYPE, ACC_TYPE, TRANS_AMT, RECEIPT_VCHR_NO, VCHR_TYPE, PL_BALANCE
        FROM LEDGER WHERE MBNO='${mbno}' AND ACC_TYPE IN ('RLN','ALN')
        ORDER BY TRANS_DATE, TRANS_NO;
    `);
    const events: LegacyEvent[] = rows.map(r => ({
        transNo: r[0], transDate: r[1], transType: r[2] as any, accType: r[3] as any,
        amt: parseFloat(r[4]), interestAmt: 0, receiptVchrNo: r[5], vchrType: r[6],
        plBalance: r[7] ? parseFloat(r[7]) : undefined,
    }));

    // The legacy demand's RLN_interest field contains the combined I1002
    // amount on this member's mixed RLN/ALN receipts; it does not represent
    // the per-loan split. Keep the unchanged regular-loan interest at the
    // observed RLN-only baseline, then assign the remainder to the active
    // ALN when both loan heads are present on the voucher.
    // Deliberately sets interestAmt, NOT amt — amt must stay principal-only
    // (see the LegacyEvent doc comment) for the FIFO exhaustion math below to
    // stay correct; the interest is folded back in only when building what
    // actually gets replayed via recordLoanRepayment().
    const interestLegs = getLegacyInterestLegs(mbno);
    const matchesForLeg = interestLegs.map(leg => ({
        leg,
        matches: events.filter(e => e.transType === 'CR' && e.transDate === leg.transDate && e.receiptVchrNo === leg.receiptVchrNo),
    }));
    const rlnOnlyInterest = matchesForLeg
        .filter(x => x.matches.some(e => e.accType === 'RLN') && !x.matches.some(e => e.accType === 'ALN') && x.leg.amt > 0)
        .map(x => round2(x.leg.amt));
    const frequency = new Map<number, number>();
    for (const amount of rlnOnlyInterest) frequency.set(amount, (frequency.get(amount) || 0) + 1);
    const fixedRlnInterest = [...frequency.entries()]
        .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
    for (const leg of interestLegs) {
        const matches = events.filter(e => e.transType === 'CR' && e.transDate === leg.transDate && e.receiptVchrNo === leg.receiptVchrNo);
        if (matches.length === 0) continue; // no matching loan leg — leave unmatched, same as the confirmed ~0.5-6% tail
        const byType = new Map<string, LegacyEvent[]>();
        for (const m of matches) {
            const rows = byType.get(m.accType) || [];
            rows.push(m);
            byType.set(m.accType, rows);
        }
        const hasRln = byType.has('RLN');
        const hasAln = byType.has('ALN');
        if (hasRln && hasAln && !(fixedRlnInterest && fixedRlnInterest > 0)) {
            for (const m of matches) {
                m.interestAllocationWarning = `Mixed RLN/ALN voucher ${leg.receiptVchrNo} on ${leg.transDate} has no RLN-only interest baseline; I1002 ₹${leg.amt} was not guessed into either loan`;
            }
            continue;
        }
        const rlnInterest = hasRln && hasAln
            ? Math.min(round2(leg.amt), fixedRlnInterest!)
            : (hasRln ? round2(leg.amt) : 0);
        const typedInterest: Record<string, number> = {
            RLN: rlnInterest,
            ALN: hasAln ? round2(Math.max(0, leg.amt - rlnInterest)) : 0,
        };
        for (const [loanType, typedRows] of byType) {
            const amount = typedInterest[loanType] ?? 0;
            const principalSum = typedRows.reduce((s, m) => s + m.amt, 0);
            if (principalSum <= 0 || amount <= 0) continue;
            let assigned = 0;
            typedRows.forEach((m, index) => {
                const share = index === typedRows.length - 1
                    ? round2(amount - assigned)
                    : round2(amount * (m.amt / principalSum));
                m.interestAmt = round2(m.interestAmt + share);
                assigned = round2(assigned + share);
            });
        }
        if (hasRln && hasAln) {
            for (const m of matches) {
                m.interestAllocationInfo = `INTEREST_SPLIT voucher=${leg.receiptVchrNo} date=${leg.transDate.slice(0, 10)} total=₹${round2(leg.amt)} RLN=₹${rlnInterest} (fixed RLN-only baseline) ALN=₹${typedInterest.ALN} (residual)`;
            }
        }
    }

    return events;
}

/** Matches the 261-event pattern found in Phase 0 drill-down: exactly one
 *  DR leg + one CR leg, same voucher, same date, same member, same amount. */
function findConsolidationEvents(events: LegacyEvent[]): ConsolidationEvent[] {
    const byVoucher = new Map<string, LegacyEvent[]>();
    for (const e of events) {
        if (e.vchrType !== 'J') continue;
        const key = `${e.receiptVchrNo}|${e.transDate}`;
        if (!byVoucher.has(key)) byVoucher.set(key, []);
        byVoucher.get(key)!.push(e);
    }
    const result: ConsolidationEvent[] = [];
    for (const [key, legs] of byVoucher) {
        if (legs.length !== 2) continue;
        const dr = legs.find(l => l.transType === 'DR');
        const cr = legs.find(l => l.transType === 'CR');
        if (!dr || !cr) continue;
        if (Math.abs(dr.amt - cr.amt) > 0.01) continue;
        if (dr.amt < MIN_CONSOLIDATION_AMOUNT) continue;
        // DR = balance increases (top-up), CR = balance decreases (paid down/closed) —
        // same direction as an ordinary disbursement (DR) vs repayment (CR) elsewhere
        // in this ledger. fromHead is the CR leg (closes), toHead is the DR leg (tops up).
        result.push({ date: dr.transDate, receiptVchrNo: dr.receiptVchrNo, amt: round2(dr.amt), fromHead: cr.accType, toHead: dr.accType, crTransNo: cr.transNo });
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
}

/** The REAL mechanism this cooperative uses for a same-type top-up/consolidation —
 *  discovered after findConsolidationEvents' J-pair pattern was shown to be almost
 *  entirely a DIFFERENT thing (RLN<->ALN cross-type reclassification, not same-type
 *  top-ups): same-type (ALN-ALN or RLN-RLN) journal pairs are functionally
 *  nonexistent in this legacy DB — 2 ALN-ALN and 0 RLN-RLN in the entire ledger,
 *  independently confirmed by direct query.
 *
 *  Instead, when a member takes a new loan of the SAME type while an earlier one of
 *  that type is still open, legacy disburses it as an ordinary 'P' (payment/
 *  disbursement) voucher, but stamps PL_BALANCE on that row as the member's new
 *  COMBINED running debt (old open balance + this new loan) — never a plain
 *  PL_BALANCE = TRANS_AMT. Confirmed at scale across the whole ledger: 4,735 ALN
 *  disbursements show PL_BALANCE > TRANS_AMT (vs 3,015 showing PL_BALANCE ==
 *  TRANS_AMT for a genuine first-time loan). Independently validated against every
 *  member with exactly two ALN cases (PL_BALANCE - TRANS_AMT vs the older case's own
 *  loan_amt minus real principal repaid before this date): 277/304 (91%) exact
 *  match, 280/304 (92%) within ₹100 — the remainder are genuine source-data
 *  anomalies on those specific cases, not a flaw in this rule.
 *
 *  There is no CR leg here to exclude (crTransNo is deliberately left blank — never
 *  equals a real transNo, so it never wrongly suppresses a real repayment). The
 *  matching case to close is left to buildAttribution's own "topup goes to whichever
 *  case is open with the latest disbursement date" cursor logic — this function only
 *  has to say THAT a same-type close+topup happened here, not resolve which specific
 *  older case receives it. */
function findPvoucherConsolidations(
    cases: LegacyCase[],
    events: LegacyEvent[],
    log: (message: string) => void = () => undefined,
): ConsolidationEvent[] {
    const PL_BALANCE_TOLERANCE = 1; // rupees — matches the validation query's own cutoff
    const result: ConsolidationEvent[] = [];

    for (const type of ['RLN', 'ALN'] as const) {
        // loanAmt<=0 cases excluded up front — same filter buildAttribution applies
        // internally (invalid/placeholder legacy rows, naturallyExhausted from the
        // very first tick). Without this, a real case immediately AFTER one of these
        // placeholders in payment-date order gets treated as "newer" relative to a
        // predecessor that's already skipped by the time the close-tick fires — the
        // cursor is then sitting on the real case itself, so the close-tick closes
        // the case that was supposed to RECEIVE the topup, cascading into every
        // later case in the chain "closing itself" and leaving every topup
        // orphaned ("no open case found to receive it"). Confirmed live on
        // 610029971: case 3470 (₹0 placeholder) sorted before case 17289 caused
        // exactly this cascade across all 11 of that member's real ALN cases.
        const sameType = cases.filter(c => c.loantype === type && c.loanAmt > 0).sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
        for (let i = 1; i < sameType.length; i++) {
            const newer = sameType[i];
            const disb = events.find(e =>
                e.accType === type && e.transType === 'DR' && e.vchrType === 'P'
                && e.transDate === newer.paymentDate && Math.abs(e.amt - newer.loanAmt) < 1
            );
            if (!disb || disb.plBalance === undefined || disb.plBalance <= disb.amt + PL_BALANCE_TOLERANCE) continue;

            const impliedPrior = round2(disb.plBalance - disb.amt);
            // A P row can snapshot the old same-type balance before a same-day
            // J voucher transfers that exact balance OUT of this loan type.
            // Counting both the stale P PL_BALANCE and the explicit J transfer
            // duplicates the same principal on two successor loans. The J CR
            // amount is direct source evidence of the liability being removed;
            // when it exactly matches the P row's implied prior balance, do not
            // invent a second same-type top-up.
            const explicitlyTransferredOut = events.some(e =>
                e.vchrType === 'J' && e.transType === 'CR' && e.accType === type
                && e.transDate.slice(0, 10) === disb.transDate.slice(0, 10)
                && Math.abs(e.amt - impliedPrior) <= PL_BALANCE_TOLERANCE
            );
            if (explicitlyTransferredOut) {
                log(`PVOUCHER_TOPUP_SUPPRESSED case=${newer.loancaseno} type=${type} date=${disb.transDate.slice(0, 10)} `
                    + `implied_prior=₹${impliedPrior} — same amount is explicitly transferred out by a J-voucher CR; prevents duplicate principal`);
                continue;
            }
            result.push({
                date: disb.transDate, receiptVchrNo: disb.receiptVchrNo, amt: impliedPrior,
                fromHead: type, toHead: type, crTransNo: '',
            });
        }
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------
// Attribution: assign each CR (repayment) event to the correct case when
// a member has multiple cases of the same loan type. FIFO by origination
// date — oldest active case absorbs payments first, matching how the
// app's own getInstallmentStatus pools money oldest-installment-first.
// A case is "active" until it is closed (either paid down to ~0 by real
// repayments, or closed via a consolidation event).
// ---------------------------------------------------------------------

interface CaseState {
    legacyCase: LegacyCase;
    closed: boolean;
    closedDate?: string;
    consolidatedInto?: string;
    repaymentsToReplay: { date: string; amount: number; principalAmount: number; interestAmount: number }[];
    toppedUpBy: number; // sum of consolidation amounts credited INTO this case
    /** Final principal-only remaining balance after the whole attribution
     *  walk — set once per type-group is fully processed (see buildAttribution's
     *  end-of-loop). Used by analysis tooling that needs "is this case still
     *  really active" without re-deriving it from repaymentsToReplay (which,
     *  since the interest-leg fix, mixes principal and interest and can no
     *  longer answer that question by itself). */
    finalRemainingPrincipal?: number;
    /** Set when this case received a top-up: the closed case's own EMI split
     *  and a watch window, armed on the real loan_master row so the app's
     *  OWN recordLoanRepayment() payroll-lag detection (see
     *  AddPayrollLagCredit1758900000000) catches a stray old-rate payment
     *  during replay exactly as it would for a live consolidation — no
     *  separate detection logic duplicated here. */
    payrollLag?: { oldPrincipal: number; oldInterest: number; effectiveFrom: string; watchUntil: string };
}

/** Same split pass-transaction.service.ts computes when arming payroll-lag
 *  detection at a live consolidation: the closed case's own monthly
 *  principal (loanAmt/noOfInstal) and whatever's left of its instalAmt. */
function computeOldEmiSplit(legacyCase: LegacyCase): { principal: number; interest: number } {
    if (!legacyCase.noOfInstal) return { principal: 0, interest: 0 };
    const principal = round2(legacyCase.loanAmt / legacyCase.noOfInstal);
    const interest = round2(legacyCase.instalAmt - principal);
    return { principal, interest };
}

function buildAttribution(cases: LegacyCase[], events: LegacyEvent[], consolidations: ConsolidationEvent[]) {
    const byType: Record<string, CaseState[]> = { RLN: [], ALN: [] };
    for (const c of cases) {
        if (!byType[c.loantype]) byType[c.loantype] = [];
        byType[c.loantype].push({ legacyCase: c, closed: false, repaymentsToReplay: [], toppedUpBy: 0 });
    }
    for (const type of Object.keys(byType)) {
        byType[type].sort((a, b) => a.legacyCase.paymentDate.localeCompare(b.legacyCase.paymentDate));
    }

    // Merge CR repayment events and consolidation events into ONE true chronological
    // stream per type and walk it in date order. Doing repayments and closes as two
    // separate passes (attribute all payments, then apply closes) was wrong: a payment
    // dated after a mid-history closure could land on the already-closed case instead
    // of its successor. Consolidation CR legs are consumed by the close event below,
    // not replayed again here as an ordinary repayment (they're an internal transfer,
    // not member cash).
    const consumedCrTransNos = new Set(consolidations.map(c => c.crTransNo));
    const flags: string[] = [];

    type Tick = { date: string; kind: 'repay' | 'close' | 'topup'; amount: number; interestAmt: number; priority: number; source?: ConsolidationEvent };

    for (const type of Object.keys(byType)) {
        const activeQueue = byType[type];

        const repayTicks: Tick[] = events
            .filter(e => e.accType === type && e.transType === 'CR' && !consumedCrTransNos.has(e.transNo))
            .map(e => ({ date: e.transDate, kind: 'repay' as const, amount: round2(e.amt), interestAmt: e.interestAmt, priority: 1 }));
        const closeTicks: Tick[] = consolidations
            .filter(c => c.fromHead === type)
            .map(c => ({ date: c.date, kind: 'close' as const, amount: c.amt, interestAmt: 0, priority: 0, source: c }));
        const topupTicks: Tick[] = consolidations
            .filter(c => c.toHead === type)
            .map(c => ({ date: c.date, kind: 'topup' as const, amount: c.amt, interestAmt: 0, priority: 0, source: c }));

        // priority 0 (close/topup) before priority 1 (repay) on the same date — a
        // same-day consolidation is the branch transaction that starts the new case's
        // life; any same-day repayment after it belongs to the post-consolidation state.
        const timeline = [...repayTicks, ...closeTicks, ...topupTicks]
            .sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority);

        // Running remaining balance per case, independent of the `.closed` flag
        // (which is reserved for an EXPLICIT consolidation-close and drives the
        // CLOSE ledger-row writing below). Without this, a case that's simply
        // paid off in full through ordinary EMIs — the common case for any
        // member with multiple same-type loans but no detected consolidation
        // event — never released the cursor, so every later payment kept
        // piling onto the same exhausted case indefinitely, driving its
        // "balance" deeply negative. `naturallyExhausted` advances the cursor
        // and excludes the case from topup targeting without fabricating a
        // fake consolidation-close ledger entry for money that was simply
        // paid off normally.
        const remaining = activeQueue.map(cs => cs.legacyCase.loanAmt);
        const naturallyExhausted = activeQueue.map(() => false);
        const EPS = 0.5; // rupees; floating-point/rounding slack before treating a case as done
        const isOpen = (i: number) => !activeQueue[i].closed && !naturallyExhausted[i];

        // Some legacy LOAN_MASTER rows carry a nonsensical loan_amt (zero or negative) —
        // pre-existing bootstrap/placeholder garbage in the 46-year-old source, not
        // anything this script produced. Exclude them upfront with a clear reason rather
        // than letting them silently sit at a negative "remaining" the whole walk and
        // surface later as a confusing "ran negative after attribution" — same money,
        // clearer cause.
        for (let i = 0; i < activeQueue.length; i++) {
            if (activeQueue[i].legacyCase.loanAmt <= 0) {
                naturallyExhausted[i] = true;
                remaining[i] = 0;
                flags.push(`Case ${activeQueue[i].legacyCase.loancaseno} (${type}) has invalid loan_amt (₹${activeQueue[i].legacyCase.loanAmt}) `
                    + `in the legacy source — excluded, not a real loan to replay`);
            }
        }

        let cursor = 0; // index of the oldest still-open case

        // A case at cursor can be permanently skipped (cursor advances) only once
        // it's truly used up (closed or naturally exhausted) — that's date-independent.
        // Whether it's AVAILABLE for a given tick also depends on its own disbursement
        // date not being in the future relative to the tick — but that must NOT advance
        // the cursor, since the same not-yet-disbursed case is exactly what a LATER
        // tick should still be able to use. Conflating "not open" with "not yet
        // disbursed" was the bug behind case 16906 (610018655): a ₹2,000 consolidation
        // dated 2023-02-23 rolled the cursor onto 16906, a ₹3,00,000 loan not disbursed
        // until 2023-02-24 — closing a loan a full day before it existed, and orphaning
        // three years of real payments that had nowhere left to land.
        const advancePastExhausted = () => { while (cursor < activeQueue.length && !isOpen(cursor)) cursor++; };

        for (const tick of timeline) {
            advancePastExhausted();

            if (tick.kind === 'repay') {
                let amountLeft = tick.amount;
                // Fixed proportion of this tick's own interest per rupee of
                // principal, computed once against the tick's ORIGINAL total
                // (not the shrinking amountLeft) — a tick that splits across
                // two cases (overflowing the first) must divide its interest
                // the same way it divides its principal, not dump it all on
                // whichever case happens to be applied first.
                const interestPerRupee = tick.amount > 0 ? tick.interestAmt / tick.amount : 0;
                while (amountLeft > EPS) {
                    advancePastExhausted();
                    if (cursor >= activeQueue.length) {
                        flags.push(`Unattributed CR ₹${round2(amountLeft)} on ${tick.date} (${type}) — no active case left to assign it to`);
                        break;
                    }
                    if (activeQueue[cursor].legacyCase.paymentDate > tick.date) {
                        flags.push(`Unattributed CR ₹${round2(amountLeft)} on ${tick.date} (${type}) — next case (${activeQueue[cursor].legacyCase.loancaseno}) `
                            + `not disbursed until ${activeQueue[cursor].legacyCase.paymentDate}, nothing open yet to receive it`);
                        break;
                    }
                    // applied/remaining[cursor]/amountLeft all stay PRINCIPAL-ONLY —
                    // this is the exhaustion bookkeeping that decides when a case's
                    // real principal balance is used up. Interest rides along
                    // separately (appliedInterest) and is folded into the amount
                    // actually sent to recordLoanRepayment() below, never into the
                    // numbers this loop uses to advance the cursor.
                    const applied = Math.min(amountLeft, remaining[cursor]);
                    if (applied > EPS) {
                        const appliedInterest = round2(applied * interestPerRupee);
                        activeQueue[cursor].repaymentsToReplay.push({
                            date: tick.date,
                            amount: round2(applied + appliedInterest),
                            principalAmount: round2(applied),
                            interestAmount: appliedInterest,
                        });
                        remaining[cursor] -= applied;
                        amountLeft -= applied;
                    }
                    if (remaining[cursor] <= EPS) {
                        naturallyExhausted[cursor] = true;
                        cursor++;
                    } else {
                        break; // this case still has room; the tick is fully consumed
                    }
                }
            } else if (tick.kind === 'close') {
                if (cursor >= activeQueue.length) {
                    flags.push(`Consolidation-close ₹${tick.amount} on ${tick.date} (${type}) — no open case found to close`);
                    continue;
                }
                // >= (not just >) — cursor sitting AT (not just after) the intended
                // RECEIVING case's own disbursement date means the real predecessor
                // was already fully paid off by ordinary repayments before this
                // consolidation date ever arrived (naturallyExhausted advanced the
                // cursor early). Closing "whatever's at cursor" here would close the
                // receiving case itself instead of a predecessor — confirmed live on
                // 610029971's case chain: every later case closed ITSELF, leaving its
                // own topup with nothing open to land on. Skip the close (there's
                // nothing left to close) and let the topup below proceed against the
                // now correctly-still-open receiving case.
                if (activeQueue[cursor].legacyCase.paymentDate >= tick.date) {
                    flags.push(`Consolidation-close ₹${tick.amount} on ${tick.date} (${type}) — case ${activeQueue[cursor].legacyCase.loancaseno} `
                        + `(disbursed ${activeQueue[cursor].legacyCase.paymentDate}) is the receiving case itself, not a predecessor — its real `
                        + `predecessor was already fully repaid before this date; skipping the close, topup still applies`);
                    continue;
                }
                activeQueue[cursor].closed = true;
                activeQueue[cursor].closedDate = tick.date;
                if (tick.source) tick.source.resolvedFromCase = activeQueue[cursor].legacyCase.loancaseno;
                cursor++;
            } else {
                // topup: goes to whichever case is currently open with the latest
                // disbursement date on/before this event — normally the case the
                // member most recently took out, not necessarily the oldest-open one.
                const candidateIdxs = activeQueue
                    .map((cs, i) => i)
                    .filter(i => isOpen(i) && activeQueue[i].legacyCase.paymentDate <= tick.date);
                const receivingIdx = candidateIdxs[candidateIdxs.length - 1];
                if (receivingIdx === undefined) {
                    flags.push(`Consolidation-topup ₹${tick.amount} on ${tick.date} (${type}) — no open case found to receive it`);
                    continue;
                }
                activeQueue[receivingIdx].toppedUpBy += tick.amount;
                remaining[receivingIdx] += tick.amount;
                if (tick.source) tick.source.resolvedToCase = activeQueue[receivingIdx].legacyCase.loancaseno;
            }
        }

        // Cases that ended up naturally exhausted with money still flowing past them are
        // fine (that's the normal lifecycle); flag any case whose remaining balance went
        // meaningfully negative anyway — it means real repayments exceeded loanAmt+topups
        // even after this fix, which points at something this script doesn't yet model.
        for (let i = 0; i < activeQueue.length; i++) {
            if (remaining[i] < -EPS) {
                flags.push(`Case ${activeQueue[i].legacyCase.loancaseno} (${type}) ran ₹${round2(-remaining[i])} negative after attribution — real repayments exceed loanAmt+topups, needs manual review`);
            }
            activeQueue[i].finalRemainingPrincipal = round2(remaining[i]);
        }
    }

    return { byType, flags };
}

// ---------------------------------------------------------------------
// Replay execution
// ---------------------------------------------------------------------

async function processMember(mbno: string, svc: LoanRepaymentService, log: (s: string) => void) {
    const cases = getLegacyCases(mbno);
    const events = getLegacyEvents(mbno);
    for (const info of new Set(events.map(e => e.interestAllocationInfo).filter(Boolean))) log(`  ${info}`);
    // Two independent, non-overlapping consolidation mechanisms in this legacy DB —
    // see findConsolidationEvents (cross-type, journal-voucher) and
    // findPvoucherConsolidations (same-type, ordinary disbursement-voucher) for why
    // neither one alone covers both real patterns.
    const consolidations = [...findConsolidationEvents(events), ...findPvoucherConsolidations(cases, events, log)]
        .sort((a, b) => a.date.localeCompare(b.date));
    const { byType, flags } = buildAttribution(cases, events, consolidations);
    for (const warning of new Set(events.map(e => e.interestAllocationWarning).filter(Boolean))) {
        flags.push(warning!);
    }

    // Arm payroll-lag detection where the stray old-rate payment will actually
    // LAND, not on the consolidation's cross-type "receiving" case. Those are
    // two different things in this legacy pattern: e.g. an old ALN case gets
    // closed and its residual balance is topped onto the member's RLN case
    // (cross-type), but the payroll deduction channel itself is still tagged
    // ALN in the ledger, so BSP's next stray old-rate ALN payment naturally
    // flows — via our own FIFO attribution above — to whatever ALN case is
    // now open, i.e. the SAME-TYPE successor of the closed case, which may be
    // a completely independent loan with no relation to the top-up at all
    // (confirmed on 610033146: 18709/ALN closes into 18094/RLN, but the
    // stray payment lands on 19603/ALN — an unrelated, coincidentally-timed
    // new loan). In the live app this distinction never arises because a
    // consolidation always tops the old balance into the NEW loan being
    // taken, which is necessarily the same type — pass-transaction.service.ts
    // only ever sees that simpler case.
    const caseByNo = new Map<string, CaseState>();
    for (const type of Object.keys(byType)) for (const cs of byType[type]) caseByNo.set(cs.legacyCase.loancaseno, cs);
    for (const cons of consolidations) {
        if (!cons.resolvedFromCase) continue;
        const closedCase = caseByNo.get(cons.resolvedFromCase);
        if (!closedCase) continue;
        const sameTypeQueue = byType[closedCase.legacyCase.loantype] || [];
        const closedIdx = sameTypeQueue.findIndex(cs => cs.legacyCase.loancaseno === closedCase.legacyCase.loancaseno);
        const successorCase = closedIdx >= 0 ? sameTypeQueue[closedIdx + 1] : undefined;
        if (!successorCase) {
            flags.push(`Consolidation closed ${closedCase.legacyCase.loancaseno} (${closedCase.legacyCase.loantype}) with no same-type successor case — `
                + `any stray old-rate payment after this has nowhere to be auto-detected, review manually`);
            continue;
        }
        const receivingCase = successorCase;
        const legacySplit = computeOldEmiSplit(closedCase.legacyCase);
        const legacyTotal = round2(legacySplit.principal + legacySplit.interest);
        // The closed case's own real, ledger-observed EMI amount — not its legacy
        // instal_amt field, which is frequently stale (same trap hit repeatedly
        // this session: e.g. case 18709's LOAN_MASTER says 3750/month, its real
        // payments were 7317/month). Use the closed case's most recent actual
        // repayment as the true "old EMI" the payroll pipeline was deducting.
        // No principal/interest split is derivable from LEDGER, so the whole
        // amount goes to oldPrincipal, 0 to oldInterest — the match gate only
        // cares about the total; the split only feeds a bookkeeping column on
        // the flagged ledger row.
        const lastReal = closedCase.repaymentsToReplay[closedCase.repaymentsToReplay.length - 1];
        const realTotal = lastReal ? lastReal.amount : 0;
        const useReal = realTotal > 0 && Math.abs(realTotal - legacyTotal) > 1;
        const split = useReal ? { principal: realTotal, interest: 0 } : legacySplit;
        if (split.principal + split.interest <= 0) continue;
        const watchUntil = new Date(cons.date);
        watchUntil.setMonth(watchUntil.getMonth() + 2);
        receivingCase.payrollLag = {
            oldPrincipal: split.principal, oldInterest: split.interest,
            effectiveFrom: cons.date.slice(0, 10),
            watchUntil: watchUntil.toISOString().slice(0, 10),
        };
    }

    let repaymentsReplayed = 0;
    let consolidationsApplied = 0;

    for (const type of Object.keys(byType)) {
        for (const cs of byType[type]) {
            const { loancaseno } = cs.legacyCase;

            // Already flagged and excluded from attribution in buildAttribution (see the
            // invalid-loan_amt check there) — skip entirely rather than computing a
            // meaningless EXPECT preview off the case's own broken source loan_amt.
            if (cs.legacyCase.loanAmt <= 0) {
                log(`  SKIPPED case=${loancaseno} type=${type} — invalid source loan_amt (₹${cs.legacyCase.loanAmt}), not a real loan`);
                continue;
            }

            // Verify the Postgres row actually exists for this (mbno, loancaseno) before touching it —
            // collisions mean loancaseno alone is never trustworthy, and (mbno, loancaseno) isn't
            // either: 233 real members have the same case number reused across RLN and ALN.
            const pgRow = await AppDataSource.query(
                `SELECT loancaseno, balance, loan_amt, rate FROM loan_master WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`,
                [mbno, loancaseno, type]
            );
            if (pgRow.length === 0) {
                flags.push(`Case ${loancaseno} (${type}) not found in Postgres for mbno ${mbno} — skipped`);
                continue;
            }

            // The legacy LOAN_MASTER table has no persisted slot/delay field.
            // The base import therefore leaves delay_months NULL, which makes
            // early-closure dates start one month too early for Slot 1 loans.
            // Reconstruct the immutable delay from the legacy origination date
            // using the same business-rule resolver as live disbursement. Only
            // NULL values are backfilled; an explicitly stored value is a
            // deliberate historical override and must remain untouched.
            const existingDelay = await AppDataSource.query(
                `SELECT payment_date, delay_months FROM loan_master
                 WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`,
                [mbno, loancaseno, type],
            );
            if (existingDelay[0]?.delay_months == null && existingDelay[0]?.payment_date) {
                const { delayMonths } = determineLoanSlot(
                    new Date(existingDelay[0].payment_date), slotRuleConfig.slot1DelayMonths,
                    slotRuleConfig.slot2DelayMonths, slotRuleConfig.slot1StartDay, slotRuleConfig.slot1EndDay,
                );
                log(`  SLOT_DELAY_BACKFILL case=${loancaseno} type=${type} delay_months=${delayMonths}`);
                if (!DRY_RUN) {
                    await AppDataSource.query(
                        `UPDATE loan_master SET delay_months = $1
                         WHERE mbno = $2 AND loancaseno::text = $3 AND loantype = $4 AND delay_months IS NULL`,
                        [delayMonths, mbno, loancaseno, type],
                    );
                }
            }

            // Schedule-exhaustion guard: getInstallmentStatus() builds EXACTLY
            // no_of_instal installments (loan-repayment.service.ts, `for (let n = 1;
            // n <= noOfInstal; n++)`), and the total principal pool across all of
            // them is always exactly loan_amt regardless of how many installments
            // that's split into — extending no_of_instal alone adds no capacity.
            // When real repayments race ahead of the nominal per-month pace (found
            // on 587 members: e.g. case 11408 received ₹1,72,486 against a declared
            // loan_amt of only ₹1,50,000), the fixed-size schedule runs out of
            // installment slots before the real money is fully accounted for, and
            // recordLoanRepayment correctly refuses further payments rather than
            // guess where they go. Fix: extend BOTH loan_amt and no_of_instal
            // together by however many extra installments (at the loan's own real
            // monthlyPrincipal rate) are needed to cover the shortfall — the same
            // "trust real observed totals over the stale declared field" treatment
            // already applied to loan_amt<=0 and consolidation top-ups elsewhere in
            // this script, just triggered by capacity instead of a detected event.
            let scheduleExtension = 0;
            const separateInterestMode = true; // migrations always preserve the source ledger model
            const totalToReplay = round2(cs.repaymentsToReplay.reduce((s, r) => s + r.amount, 0));
            const impliedTotal = round2(cs.toppedUpBy + totalToReplay);
            // A consolidated (topped-up) case's TRUE principal capacity is its own
            // declared loan_amt PLUS whatever it absorbed from a closed predecessor
            // (cs.toppedUpBy) — comparing impliedTotal (which already includes
            // toppedUpBy) against loanAmt ALONE double-counts every rupee of
            // absorbed debt as "overflow," inflating loan_amt/balance by roughly
            // toppedUpBy on top of any genuine shortfall. Confirmed live on
            // 610026970 case 17416: real principal-only repayments (₹4,66,656)
            // almost exactly matched its true combined absorbed principal
            // (₹4,61,656 original chain + an untracked ₹5,000 top-up) — it should
            // have shown ~₹0 balance, but the old comparison (against loanAmt=
            // ₹58,330 alone, ignoring toppedUpBy=₹2,41,670) inflated it to
            // ₹8,22,782.63 loan_amt / ₹4,92,442.57 balance.
            const effectiveCapacity = round2(cs.legacyCase.loanAmt + cs.toppedUpBy);
            if (!separateInterestMode && impliedTotal > effectiveCapacity + BALANCE_TOLERANCE && cs.legacyCase.noOfInstal > 0) {
                // Real overflow: total money genuinely exceeds the case's true capacity
                // (own declared loan_amt + anything absorbed via consolidation) — the
                // same stale-legacy-field pattern as loan_amt<=0, just measured against
                // the right baseline — extend BOTH loan_amt and no_of_instal together,
                // same rate.
                const monthlyPrincipal = cs.legacyCase.loanAmt / cs.legacyCase.noOfInstal;
                const shortfall = round2(impliedTotal - effectiveCapacity);
                const extraInstallments = Math.ceil(shortfall / monthlyPrincipal) + 3; // +3 slack for the pacing issue below, since this case can hit it too
                const extraAmount = round2(extraInstallments * monthlyPrincipal);
                scheduleExtension = extraAmount;
                log(`  SCHEDULE_EXTENDED case=${loancaseno} type=${type} real total ₹${impliedTotal} exceeds true capacity ₹${effectiveCapacity} `
                    + `(own ₹${cs.legacyCase.loanAmt} + absorbed ₹${cs.toppedUpBy}) by ₹${shortfall} — extending +${extraInstallments} installments (+₹${extraAmount} loan_amt/balance/no_of_instal)`);
                if (!DRY_RUN) {
                    await AppDataSource.query(
                        `UPDATE loan_master SET loan_amt = loan_amt + $1, balance = balance + $1, no_of_instal = no_of_instal + $2
                         WHERE mbno = $3 AND loancaseno::text = $4 AND loantype = $5`,
                        [extraAmount, extraInstallments, mbno, loancaseno, type]
                    );
                }
            } else if (!separateInterestMode && !cs.closed
                && impliedTotal >= effectiveCapacity - BALANCE_TOLERANCE * 20
                && cs.legacyCase.noOfInstal > 0) {
                // Pacing exhaustion: total money never exceeds loan_amt, but real payments
                // arrived faster than the calendar-monthly schedule (getInstallmentStatus
                // builds exactly no_of_instal installments, one per month from
                // disbursement) — "future prepayment" races through every slot before all
                // the matching money can be placed, leaving a small residual with nowhere
                // to go even though nothing is actually overpaid. Fix: extend no_of_instal
                // ALONE (not loan_amt) — since monthlyPrincipal = loan_amt/no_of_instal,
                // more installments at the same loan_amt just adds schedule slots without
                // inflating what's owed. Found on 72 members this session, residuals from
                // ~₹1 to ~₹1,000 — a near-full-payoff-only trigger (loanAmt-1000 floor)
                // so this never fires on a case nowhere near being paid off.
                // Explicitly consolidated cases are excluded: their original
                // tenure is a source fact and must not be changed by this
                // open-case pacing workaround.
                const EXTRA_SLOTS = 8;
                log(`  SCHEDULE_SLACK_ADDED case=${loancaseno} type=${type} real total ₹${impliedTotal} near true capacity ₹${effectiveCapacity} `
                    + `(pacing outran the monthly schedule) — adding +${EXTRA_SLOTS} installment slots, no_of_instal only`);
                if (!DRY_RUN) {
                    await AppDataSource.query(
                        `UPDATE loan_master SET no_of_instal = no_of_instal + $1 WHERE mbno = $2 AND loancaseno::text = $3 AND loantype = $4`,
                        [EXTRA_SLOTS, mbno, loancaseno, type]
                    );
                }
            }

            if (cs.toppedUpBy > 0) {
                log(`  CONSOLIDATION_APPLIED case=${loancaseno} type=${type} +₹${cs.toppedUpBy} (loan_amt/balance increased)`);
                if (!DRY_RUN) {
                    // loantype-scoped — loancaseno collides across types for the same
                    // member on real data (233 members found this session); an
                    // unscoped UPDATE here corrupted a same-numbered sibling case's
                    // balance/loan_amt on every call. Fixed here and in the two
                    // production services after discovering it live.
                    await AppDataSource.query(
                        `UPDATE loan_master
                         SET balance = COALESCE(balance, 0) + ($1 - COALESCE(loan_amt, 0)), loan_amt = $1
                         WHERE mbno = $2 AND loancaseno::text = $3 AND loantype = $4`,
                        [effectiveCapacity, mbno, loancaseno, type]
                    );
                }
                consolidationsApplied++;
            }

            // Armed independently of toppedUpBy — the case watching for a stray
            // old-rate payment is often a different case than the one that
            // received the consolidation's balance top-up (see comment above).
            // Must run BEFORE this case's own repayments are replayed below, so
            // recordLoanRepayment()'s detection sees the watch window already set.
            if (cs.payrollLag) {
                log(`  PAYROLL_LAG_ARMED case=${loancaseno} old=₹${cs.payrollLag.oldPrincipal}+₹${cs.payrollLag.oldInterest} `
                    + `watch_until=${cs.payrollLag.watchUntil}`);
                if (!DRY_RUN) {
                    await AppDataSource.query(
                        `UPDATE loan_master SET payroll_lag_watch_until = $1, payroll_lag_old_principal = $2, payroll_lag_old_interest = $3
                         WHERE mbno = $4 AND loancaseno::text = $5 AND loantype = $6`,
                        [cs.payrollLag.watchUntil, cs.payrollLag.oldPrincipal, cs.payrollLag.oldInterest, mbno, loancaseno, type]
                    );
                }
            }

            // The first old-EMI match inside the armed watch window is a
            // predecessor-loan payroll deduction. It must stay in the audit
            // ledger, but must not be replayed as a payment against this
            // successor case. The normal repayment service can detect this
            // for live transactions; explicit component replay used here had
            // previously bypassed that detector and inserted false instead.
            const payrollLagReplay = cs.payrollLag
                ? cs.repaymentsToReplay.find(r =>
                    r.date.slice(0, 10) >= cs.payrollLag!.effectiveFrom
                    && r.date.slice(0, 10) <= cs.payrollLag!.watchUntil
                    && Math.abs(r.amount - round2(cs.payrollLag!.oldPrincipal + cs.payrollLag!.oldInterest)) < 1)
                : undefined;
            const receivedConsolidations = consolidations
                .filter(c => c.resolvedToCase === loancaseno)
                .sort((a, b) => a.date.localeCompare(b.date));
            const scheduleBoundaries: Array<{ event: ConsolidationEvent; source: 'ORIGINATION' | 'CONSOLIDATION' }> = [];
            const originationDate = cs.legacyCase.paymentDate.slice(0, 10);
            if (!receivedConsolidations.some(c => c.date.slice(0, 10) === originationDate)) {
                scheduleBoundaries.push({
                    event: {
                        date: originationDate, receiptVchrNo: '', amt: 0,
                        fromHead: type as ConsolidationEvent['fromHead'],
                        toHead: type as ConsolidationEvent['toHead'], crTransNo: '',
                    },
                    source: 'ORIGINATION',
                });
            }
            // Several matched journal legs can describe the same receiving
            // schedule on one effective date. Keep one schedule boundary for
            // that date/head; the principal top-up itself is still calculated
            // from the complete receivedConsolidations collection below.
            const consolidationScheduleEvents = new Map<string, ConsolidationEvent>();
            for (const event of receivedConsolidations) {
                const key = `${event.date.slice(0, 10)}|${event.toHead}`;
                if (!consolidationScheduleEvents.has(key)) consolidationScheduleEvents.set(key, event);
            }
            scheduleBoundaries.push(...[...consolidationScheduleEvents.values()].map(event => ({ event, source: 'CONSOLIDATION' as const })));
            scheduleBoundaries.sort((a, b) => a.event.date.localeCompare(b.event.date));
            const transitionPayrollRows = new Set<typeof cs.repaymentsToReplay[number]>();
            const transitionWindows = scheduleBoundaries.map((boundary, index) => {
                const { event, source } = boundary;
                const effectiveDate = event.date.slice(0, 10);
                const delayMonths = determineLoanSlot(
                    new Date(`${effectiveDate}T12:00:00`), slotRuleConfig.slot1DelayMonths,
                    slotRuleConfig.slot2DelayMonths, slotRuleConfig.slot1StartDay, slotRuleConfig.slot1EndDay,
                ).delayMonths;
                const date = new Date(`${effectiveDate}T12:00:00`);
                const due = new Date(date.getFullYear(), date.getMonth() + 1 + delayMonths, 1);
                const firstDueMonth = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-01`;
                const nextEventDate = scheduleBoundaries[index + 1]?.event.date.slice(0, 10);
                for (const repayment of cs.repaymentsToReplay) {
                    // BSP payroll during the slot-delay window is still the
                    // predecessor loan's deduction, including at a new
                    // origination. Keep it auditable on this case, but exclude
                    // it from this schedule and from current-loan principal.
                    if (isSlotDelayPayroll(repayment.date, effectiveDate, firstDueMonth, nextEventDate)) {
                        transitionPayrollRows.add(repayment);
                    }
                }
                return { event, source, effectiveDate, firstDueMonth, delayMonths, nextEventDate };
            });
            const payrollLagReplayRows = new Set<typeof cs.repaymentsToReplay[number]>(transitionPayrollRows);
            if (payrollLagReplay) payrollLagReplayRows.add(payrollLagReplay);
            for (const row of transitionPayrollRows) {
                log(`  TRANSITION_PAYROLL_EXCLUDED case=${loancaseno} date=${row.date} amount=₹${row.amount} — paid during the slot-delay window before the applicable schedule's first due month`);
            }

            // Rebuild each effective principal schedule from origination and
            // consolidation boundaries, not the most-common principal amount across the
            // entire case history. Earlier repayments remain historical and
            // reduce the balance reaching each boundary; the first eligible
            // post-slot-delay repayment defines the constant principal for
            // that agreement version.
            if (separateInterestMode && scheduleBoundaries.length > 0) {
                const basePrincipal = round2(cs.legacyCase.loanAmt);
                const annualRate = parseFloat(pgRow[0]?.rate) || 0;
                if (annualRate <= 0) {
                    flags.push(`SCHEDULE_VERSION_NOT_BUILT case=${loancaseno}: Postgres annual rate is missing/invalid; refusing to guess a rate`);
                }
                const scheduleSnapshots: Array<{
                    source: 'ORIGINATION' | 'CONSOLIDATION';
                    effectiveDate: string; firstDueMonth: string; openingPrincipal: number;
                    monthlyPrincipal: number; monthlyInterest: number; installmentCount: number;
                    delayMonths: number; sourceCaseNo: string | null;
                }> = [];
                for (let index = 0; annualRate > 0 && index < transitionWindows.length; index++) {
                    const { event, source, effectiveDate, firstDueMonth, delayMonths, nextEventDate } = transitionWindows[index];
                    const priorTopups = receivedConsolidations
                        .filter(c => c.date <= event.date)
                        .reduce((sum, c) => sum + c.amt, 0);
                    const priorPrincipalPaid = cs.repaymentsToReplay
                        // A slot-delay payroll row belongs to the prior loan
                        // schedule. Keep it in the ledger for audit/closure
                        // adjustment, but do not subtract it from this loan's
                        // principal at any schedule boundary. Otherwise a
                        // predecessor EMI lowers the successor's schedule
                        // opening principal and is effectively counted twice.
                        .filter(r => r.date.slice(0, 10) < effectiveDate)
                        .filter(r => !payrollLagReplayRows.has(r))
                        .reduce((sum, r) => sum + r.principalAmount, 0);
                    const boundaryOpeningPrincipal = round2(basePrincipal + priorTopups - priorPrincipalPaid);
                    const openingPrincipal = boundaryOpeningPrincipal;
                    const eligiblePayments = cs.repaymentsToReplay
                        .filter(r => r.date.slice(0, 7) >= firstDueMonth.slice(0, 7)
                            && (!nextEventDate || r.date.slice(0, 10) < nextEventDate)
                            && !payrollLagReplayRows.has(r) && r.principalAmount > 0)
                        .sort((a, b) => a.date.localeCompare(b.date));
                    const firstCurrentPayment = selectFirstRecurringPrincipal(eligiblePayments);
                    if (openingPrincipal <= 0) {
                        flags.push(`SCHEDULE_VERSION_NOT_BUILT case=${loancaseno} schedule=${event.date}: opening principal is zero/paid off before first due month (boundary ₹${boundaryOpeningPrincipal}); no future schedule was seeded`);
                        continue;
                    }
                    if (!firstCurrentPayment) {
                        const observed = eligiblePayments.map(r => `${r.date.slice(0, 10)}:${round2(r.principalAmount)}`).join(', ');
                        flags.push(`SCHEDULE_VERSION_NOT_BUILT case=${loancaseno} schedule=${event.date}: no recurring principal payment found after slot delay; refusing to infer a term from a one-off residue or adjustment (observed ${observed || 'none'})`);
                        continue;
                    }
                    const monthlyPrincipal = round2(firstCurrentPayment.principalAmount);
                    const exactTerm = openingPrincipal / monthlyPrincipal;
                    const nearestTerm = Math.round(exactTerm);
                    // Small absolute rounding residues belong in the final
                    // installment, not in a phantom extra month (e.g.
                    // ₹781,654 / ₹19,541 = 40.0007 => 40 installments, with
                    // the ₹14 residue absorbed by the last principal amount).
                    const installmentCount = Math.max(1,
                        Math.abs(exactTerm - nearestTerm) <= 0.02
                            ? nearestTerm
                            : Math.ceil(exactTerm));
                    if (installmentCount > 32767) {
                        flags.push(`SCHEDULE_VERSION_NOT_BUILT case=${loancaseno} schedule=${event.date}: inferred term ${installmentCount} exceeds the database smallint limit; principal seed ₹${monthlyPrincipal} is not accepted`);
                        continue;
                    }
                    scheduleSnapshots.push({
                        source,
                        effectiveDate,
                        firstDueMonth,
                        openingPrincipal,
                        monthlyPrincipal,
                        monthlyInterest: round2(firstCurrentPayment.interestAmount),
                        installmentCount,
                        delayMonths,
                        sourceCaseNo: event.resolvedFromCase ?? null,
                    });
                }
                for (let index = 0; index < scheduleSnapshots.length; index++) {
                    const snapshot = scheduleSnapshots[index];
                    const monthlyInstallment = round2(snapshot.monthlyPrincipal + snapshot.monthlyInterest);
                    log(`  EFFECTIVE_SCHEDULE case=${loancaseno} v${index + 1} source=${snapshot.source} effective=${snapshot.effectiveDate} first_due_month=${snapshot.firstDueMonth} `
                        + `opening_principal=₹${snapshot.openingPrincipal} principal_emi=₹${snapshot.monthlyPrincipal} interest=₹${snapshot.monthlyInterest} `
                        + `term=${snapshot.installmentCount} delay=${snapshot.delayMonths} source_case=${snapshot.sourceCaseNo ?? 'n/a'}`);
                    if (!DRY_RUN) {
                        if (index === 0) {
                            // A prior interrupted/failed replay may have left
                            // autocommitted schedule rows even though the
                            // member batch was rolled back. Replace the whole
                            // case's derived schedule set, including removing
                            // stale invalid rows when no new snapshot exists.
                            await AppDataSource.query(
                                `DELETE FROM loan_schedule_versions WHERE mbno=$1 AND loantype=$2 AND loancaseno::text=$3`,
                                [mbno, type, loancaseno],
                            );
                        }
                        await AppDataSource.query(
                            `INSERT INTO loan_schedule_versions
                                (mbno, loantype, loancaseno, version_no, source, effective_date, first_due_month,
                                 opening_principal, monthly_principal, installment_count, monthly_installment,
                                 annual_rate, delay_months, source_case_no)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                             ON CONFLICT (mbno, loantype, loancaseno, version_no) DO UPDATE SET
                                source=EXCLUDED.source, effective_date=EXCLUDED.effective_date,
                                first_due_month=EXCLUDED.first_due_month, opening_principal=EXCLUDED.opening_principal,
                                monthly_principal=EXCLUDED.monthly_principal, installment_count=EXCLUDED.installment_count,
                                monthly_installment=EXCLUDED.monthly_installment, annual_rate=EXCLUDED.annual_rate,
                                delay_months=EXCLUDED.delay_months, source_case_no=EXCLUDED.source_case_no`,
                            [mbno, type, loancaseno, index + 1, snapshot.source, snapshot.effectiveDate, snapshot.firstDueMonth,
                                snapshot.openingPrincipal, snapshot.monthlyPrincipal, snapshot.installmentCount,
                                monthlyInstallment, annualRate, snapshot.delayMonths, snapshot.sourceCaseNo],
                        );
                    }
                }
                if (!DRY_RUN && scheduleSnapshots.length === 0) {
                    // A previous failed run may have committed a bad schedule
                    // before hitting the smallint installment-count error.
                    await AppDataSource.query(
                        `DELETE FROM loan_schedule_versions WHERE mbno=$1 AND loantype=$2 AND loancaseno::text=$3`,
                        [mbno, type, loancaseno],
                    );
                }
                const latestSnapshot = scheduleSnapshots[scheduleSnapshots.length - 1];
                if (latestSnapshot && !cs.closed) {
                    const latestTotalInstallment = round2(latestSnapshot.monthlyPrincipal + latestSnapshot.monthlyInterest);
                    if (!DRY_RUN) {
                        await AppDataSource.query(
                            `UPDATE loan_master SET no_of_instal=$1, instal_amt=$2,
                                loan_payment_model='SEPARATE_INTEREST', loan_interest_method='REDUCING_BALANCE'
                             WHERE mbno=$3 AND loancaseno::text=$4 AND loantype=$5`,
                            [latestSnapshot.installmentCount, latestTotalInstallment, mbno, loancaseno, type],
                        );
                    }
                }
            }

            type ExistingReplayRow = {
                id: number | string;
                receipt_no: string | null;
                payment_amount: number | string;
                principal_amount: number | string;
                interest_amount: number | string;
                penal_amount: number | string;
                is_payroll_lag_credit: boolean | null;
            };
            const existingReplayRows: ExistingReplayRow[] = !DRY_RUN ? await AppDataSource.query<ExistingReplayRow[]>(
                `SELECT id, receipt_no, payment_amount, principal_amount, interest_amount, penal_amount,
                        is_payroll_lag_credit
                 FROM loan_repayment_ledger
                 WHERE mbno=$1 AND loantype=$2 AND loancaseno::text=$3 AND posted_by='phase2-replay'
                   AND COALESCE(narration, '') <> 'Legacy consolidation replay: closed, folded into successor case'
                 ORDER BY id`,
                [mbno, type, loancaseno],
            ) : [];
            const replayReceiptRows = new Map<string, typeof existingReplayRows>();
            const sourceReceiptCounts = new Map<string, number>();
            const receiptFingerprint = (receiptNo: string, amount: number, principal: number, interest: number, penal = 0) =>
                [receiptNo, round2(amount), round2(principal), round2(interest), round2(penal)].join('|');
            for (const r of cs.repaymentsToReplay) {
                const receiptNo = `LR-${loancaseno}-${r.date.slice(0, 10)}`;
                const key = receiptFingerprint(receiptNo, r.amount, r.principalAmount, r.interestAmount);
                sourceReceiptCounts.set(key, (sourceReceiptCounts.get(key) || 0) + 1);
            }
            for (const row of existingReplayRows) {
                const key = receiptFingerprint(row.receipt_no || '', Number(row.payment_amount),
                    Number(row.principal_amount), Number(row.interest_amount), Number(row.penal_amount));
                const matches = replayReceiptRows.get(key) || [];
                matches.push(row);
                replayReceiptRows.set(key, matches);
            }
            // Earlier interrupted runs could have committed the same replay
            // receipt repeatedly. Retain exactly the multiplicity present in
            // the source; remove only surplus rows whose full fingerprint is
            // positively matched to a source receipt. Unknown rows are kept
            // for manual review, never guessed away.
            for (const [key, matches] of replayReceiptRows) {
                const sourceCount = sourceReceiptCounts.get(key) || 0;
                if (sourceCount === 0 || matches.length <= sourceCount) continue;
                const { retained, excess: duplicates } = partitionReplayReceiptCopies(matches, sourceCount);
                replayReceiptRows.set(key, retained);
                for (const duplicate of duplicates) {
                    const deleted = await AppDataSource.query(
                        `DELETE FROM loan_repayment_ledger WHERE id=$1 AND mbno=$2 AND loantype=$3
                           AND loancaseno::text=$4 AND posted_by='phase2-replay'
                         RETURNING principal_amount, is_payroll_lag_credit`,
                        [duplicate.id, mbno, type, loancaseno],
                    );
                    const principal = round2(Number(deleted[0]?.principal_amount) || 0);
                    if (principal > 0 && deleted[0]?.is_payroll_lag_credit !== true && !cs.closed) {
                        await AppDataSource.query(
                            `UPDATE loan_master SET balance=COALESCE(balance, 0)+$1
                             WHERE mbno=$2 AND loancaseno::text=$3 AND loantype=$4`,
                            [principal, mbno, loancaseno, type],
                        );
                    }
                    log(`  DUPLICATE_REPLAY_REMOVED case=${loancaseno} row=${duplicate.id} principal=₹${principal} — surplus identical receipt beyond source multiplicity`);
                }
            }
            for (const r of cs.repaymentsToReplay) {
                const isPayrollLagCredit = payrollLagReplayRows.has(r);
                log(`  REPAYMENT case=${loancaseno} type=${type} date=${r.date} amount=₹${r.amount} principal=₹${r.principalAmount} interest=₹${r.interestAmount}`);
                if (!DRY_RUN) {
                    const receiptNo = `LR-${loancaseno}-${r.date.slice(0, 10)}`;
                    const key = receiptFingerprint(receiptNo, r.amount, r.principalAmount, r.interestAmount);
                    const existingMatches = replayReceiptRows.get(key) || [];
                    const existingRow = existingMatches.shift();
                    replayReceiptRows.set(key, existingMatches);
                    if (existingRow) {
                        if (isPayrollLagCredit && existingRow.is_payroll_lag_credit !== true) {
                            const changed = await AppDataSource.query(
                                `UPDATE loan_repayment_ledger SET is_payroll_lag_credit=true
                                 WHERE id=$1 AND mbno=$2 AND loantype=$3 AND loancaseno::text=$4
                                   AND COALESCE(is_payroll_lag_credit, false)=false
                                 RETURNING principal_amount`,
                                [existingRow.id, mbno, type, loancaseno],
                            );
                            const restoredPrincipal = round2(Number(changed[0]?.principal_amount) || 0);
                            if (restoredPrincipal > 0 && !cs.closed) {
                                await AppDataSource.query(
                                    `UPDATE loan_master SET balance=COALESCE(balance, 0)+$1
                                     WHERE mbno=$2 AND loancaseno::text=$3 AND loantype=$4`,
                                    [restoredPrincipal, mbno, loancaseno, type],
                                );
                                log(`    -> Reclassified prior slot-delay payroll as predecessor credit; restored ₹${restoredPrincipal} to current principal.`);
                            }
                        }
                        log('    -> SKIPPED exact replay receipt already committed by an earlier interrupted run.');
                        continue;
                    }
                    const result = await svc.recordLoanRepayment({
                        // receipt_no is varchar(30) — the original 'LEGACYREPLAY-<case>-<full timestamp>'
                        // format overflowed it on every single call, failing 100% of the live batch
                        // (safely, each member rolled back cleanly, but zero writes landed). Date-only,
                        // no unique constraint on this column so a same-day split repayment on one case
                        // reusing the same receipt_no is harmless.
                        mbno, loancaseno, loantype: type, paymentAmount: r.amount,
                        receiptNo,
                        narration: 'Legacy ledger replay (Phase 2 bulk migration)',
                        username: 'phase2-replay',
                        asOfDate: new Date(r.date),
                        principalAmount: r.principalAmount,
                        interestAmount: r.interestAmount,
                        isPayrollLagCredit,
                    });
                    log(`    -> ${result.message}`);
                }
                repaymentsReplayed++;
            }

            if (cs.closed) {
                const matchingEvent = consolidations.find(c => c.resolvedFromCase === loancaseno);
                const consolidatedInto = matchingEvent?.resolvedToCase ?? '(unresolved)';
                log(`  CLOSE case=${loancaseno} type=${type} date=${cs.closedDate} -> consolidated_into=${consolidatedInto}`);
                if (!DRY_RUN) {
                    const remaining = await AppDataSource.query(
                        `SELECT balance FROM loan_master WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`, [mbno, loancaseno, type]
                    );
                    const remBal = round2(parseFloat(remaining[0]?.balance ?? '0'));
                    // consolidated_into_loancaseno — same column the live app's own
                    // PassTransactionService sets on a real-time consolidation (see
                    // Transaction Flow Atlas §1b). Without this, a migrated member's
                    // closed case zeroes out correctly but the UI has no way to show
                    // which successor case it rolled into. Only set when actually
                    // resolved (never '(unresolved)') — an unresolved close leaves the
                    // column null, same as before, so it isn't silently mislabeled.
                    await AppDataSource.query(
                        consolidatedInto === '(unresolved)'
                            ? `UPDATE loan_master SET balance = 0 WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`
                            : `UPDATE loan_master SET balance = 0, consolidated_into_loancaseno = $4 WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`,
                        consolidatedInto === '(unresolved)' ? [mbno, loancaseno, type] : [mbno, loancaseno, type, consolidatedInto]
                    );
                    const closeNarration = 'Legacy consolidation replay: closed, folded into successor case';
                    const closeExists = await AppDataSource.query(
                        `SELECT 1 FROM loan_repayment_ledger WHERE mbno=$1 AND loantype=$2 AND loancaseno::text=$3
                         AND posted_by='phase2-replay' AND narration=$4 LIMIT 1`,
                        [mbno, type, loancaseno, closeNarration],
                    );
                    if (closeExists.length === 0) {
                        await AppDataSource.query(
                            `INSERT INTO loan_repayment_ledger
                                (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                                 principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 0, 0, 0, NULL, $8, $9)`,
                            [mbno, loancaseno, type, new Date(cs.closedDate!),
                                new Date(cs.closedDate!).getMonth() + 1, new Date(cs.closedDate!).getFullYear(), remBal,
                                closeNarration, 'phase2-replay']
                        );
                    }
                }
            }

            // Independent sanity check: expected balance = loanAmt + topups - sum(repayments), vs what
            // recordLoanRepayment actually produced. Flag anything beyond tolerance rather than trust silently.
            // Mirrors (doesn't call) the real payroll-lag detection purely so this preview's arithmetic
            // matches what will actually happen live — the first repayment inside the watch window that
            // matches the old EMI total is excluded from the sum, same as recordLoanRepayment does for real.
            const payrollLagExcluded = [...payrollLagReplayRows].reduce((sum, r) => sum + r.amount, 0);
            if (cs.payrollLag) {
                const oldTotal = round2(cs.payrollLag.oldPrincipal + cs.payrollLag.oldInterest);
                const match = cs.repaymentsToReplay.find(r =>
                    r.date.slice(0, 10) >= cs.payrollLag!.effectiveFrom
                    && r.date.slice(0, 10) <= cs.payrollLag!.watchUntil
                    && Math.abs(r.amount - oldTotal) < 1);
                if (match) {
                    log(`  PAYROLL_LAG_DETECTED case=${loancaseno} date=${match.date} amount=₹${match.amount} — predecessor-loan receipt; not applied to successor principal or installments`);
                }
            }
            const payrollLagPrincipalExcluded = [...payrollLagReplayRows].reduce((sum, r) => sum + r.principalAmount, 0);
            const expected = separateInterestMode
                ? round2(cs.legacyCase.loanAmt + cs.toppedUpBy
                    - cs.repaymentsToReplay.reduce((s, r) => s + r.principalAmount, 0)
                    + payrollLagPrincipalExcluded)
                : round2(cs.legacyCase.loanAmt + scheduleExtension + cs.toppedUpBy
                    - cs.repaymentsToReplay.reduce((s, r) => s + r.amount, 0) + payrollLagExcluded);
            if (!cs.closed && !DRY_RUN) {
                const after = await AppDataSource.query(
                    `SELECT balance FROM loan_master WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`, [mbno, loancaseno, type]
                );
                const actual = round2(parseFloat(after[0]?.balance ?? '0'));
                if (Math.abs(actual - expected) > BALANCE_TOLERANCE) {
                    flags.push(`Case ${loancaseno} balance mismatch after replay: expected ~₹${expected}, got ₹${actual} (diff ₹${round2(actual - expected)})`);
                }
            } else if (!cs.closed) {
                log(`  EXPECT case=${loancaseno} final balance ~₹${expected} (dry run — not verified against a real write)`);
            }
        }
    }

    return { repaymentsReplayed, consolidationsApplied, flags, casesProcessed: cases.length };
}

async function reconcileMemberLoanBalanceSummary(mbno: string): Promise<{ regular: number; emergency: number } | null> {
    const rows = await AppDataSource.query(
        `WITH totals AS (
            SELECT mbno,
                   COALESCE(SUM(CASE WHEN UPPER(COALESCE(loantype, '')) IN ('ELN','ALN','A','E','EMR','ADD')
                                          OR UPPER(COALESCE(loantype, '')) LIKE '%EMERGENCY%'
                                     THEN COALESCE(balance, 0) ELSE 0 END), 0) AS emergency_balance,
                   COALESCE(SUM(CASE WHEN UPPER(COALESCE(loantype, '')) IN ('ELN','ALN','A','E','EMR','ADD')
                                          OR UPPER(COALESCE(loantype, '')) LIKE '%EMERGENCY%'
                                     THEN 0 ELSE COALESCE(balance, 0) END), 0) AS regular_balance
            FROM loan_master WHERE mbno=$1 GROUP BY mbno
         )
         UPDATE member_balances mb
         SET emergency_loan_balance=totals.emergency_balance, regularloan=totals.regular_balance
         FROM totals WHERE mb.mbno=totals.mbno
         RETURNING mb.regularloan, mb.emergency_loan_balance`,
        [mbno],
    );
    if (!rows[0]) return null;
    return {
        regular: round2(Number(rows[0].regularloan) || 0),
        emergency: round2(Number(rows[0].emergency_loan_balance) || 0),
    };
}

async function main() {
    console.log(`===== Phase 2 bulk ledger replay — DRY_RUN=${DRY_RUN} =====`);
    if (DRY_RUN) {
        console.log('Running in DRY RUN. No Postgres writes will occur. Set DRY_RUN=false and CONFIRM_LIVE_RUN=yes-i-mean-it to write for real.');
    } else {
        console.log('!!! LIVE RUN — writing real repayment history to Postgres for real members !!!');
    }

    await AppDataSource.initialize();
    const slotRows = await AppDataSource.query(
        `SELECT key, value FROM system_configs
         WHERE key = ANY($1::text[]) AND "isActive" = true`,
        [['RULE_LOAN_SLOT1_DELAY_MONTHS', 'RULE_LOAN_SLOT2_DELAY_MONTHS',
            'RULE_LOAN_SLOT1_START_DAY', 'RULE_LOAN_SLOT1_END_DAY']],
    );
    const slotValues = new Map<string, number>(slotRows.map((r: any) => [r.key, Number(r.value)]));
    const readSlotValue = (key: string, fallback: number) => {
        const value = slotValues.get(key);
        const min = key.includes('DELAY') ? 0 : 1;
        const max = key.includes('DELAY') ? 24 : 31;
        return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
    };
    slotRuleConfig = {
        slot1DelayMonths: readSlotValue('RULE_LOAN_SLOT1_DELAY_MONTHS', 1),
        slot2DelayMonths: readSlotValue('RULE_LOAN_SLOT2_DELAY_MONTHS', 2),
        slot1StartDay: readSlotValue('RULE_LOAN_SLOT1_START_DAY', DEFAULT_SLOT1_START_DAY),
        slot1EndDay: readSlotValue('RULE_LOAN_SLOT1_END_DAY', DEFAULT_SLOT1_END_DAY),
    };
    console.log(`Slot rules used for historical schedule reconstruction: ${JSON.stringify(slotRuleConfig)}`);
    const rdRules = new RdRulesService(AppDataSource);
    const rdBal = new RdBalanceEventsService(AppDataSource, rdRules);
    const elig = new LoanEligibilityService(AppDataSource, rdBal, rdRules);
    const svc = new LoanRepaymentService(AppDataSource, elig, rdBal);

    const members = getMembersInScope();
    console.log(`Members in scope: ${members.length}${MBNO_FILTER ? ` (filtered to ${MBNO_FILTER})` : ''}${MEMBER_LIMIT ? ` (limited to first ${MEMBER_LIMIT})` : ''}`);

    let totalRepayments = 0, totalConsolidations = 0, totalFlags = 0;
    const allFlags: { mbno: string; flag: string }[] = [];

    for (const mbno of members) {
        if (!DRY_RUN) {
            const existing = await AppDataSource.query(
                `SELECT status FROM legacy_replay_batch_log WHERE mbno = $1`, [mbno]
            );
            if (existing[0]?.status === 'done' && !REPLAY_COMPLETED) {
                console.log(`\n[${mbno}] already done, skipping`);
                continue;
            }
        }

        console.log(`\n===== ${mbno} =====`);
        const runner = AppDataSource.createQueryRunner();
        await runner.connect();
        if (!DRY_RUN) await runner.startTransaction();
        try {
            const { repaymentsReplayed, consolidationsApplied, flags, casesProcessed } =
                await processMember(mbno, svc, (s) => console.log(s));

            if (!DRY_RUN) {
                const memberLoanBalances = await reconcileMemberLoanBalanceSummary(mbno);
                if (memberLoanBalances) {
                    console.log(`  MEMBER_LOAN_BALANCES_RECONCILED regular=₹${memberLoanBalances.regular} emergency=₹${memberLoanBalances.emergency} (sum of loan_master balances)`);
                }
            }

            totalRepayments += repaymentsReplayed;
            totalConsolidations += consolidationsApplied;
            totalFlags += flags.length;
            for (const f of flags) { allFlags.push({ mbno, flag: f }); console.log(`  FLAG: ${f}`); }

            if (!DRY_RUN) {
                await AppDataSource.query(`
                    INSERT INTO legacy_replay_batch_log (mbno, status, dry_run, cases_processed, repayments_replayed, consolidations_applied, flags, started_at, finished_at)
                    VALUES ($1, 'done', false, $2, $3, $4, $5, now(), now())
                    ON CONFLICT (mbno) DO UPDATE SET status='done', cases_processed=$2, repayments_replayed=$3, consolidations_applied=$4, flags=$5, finished_at=now()
                `, [mbno, casesProcessed, repaymentsReplayed, consolidationsApplied, JSON.stringify(flags)]);
                await runner.commitTransaction();
            }
        } catch (e: any) {
            console.error(`  ERROR for ${mbno}: ${e.message}`);
            if (!DRY_RUN) {
                await runner.rollbackTransaction();
                await AppDataSource.query(`
                    INSERT INTO legacy_replay_batch_log (mbno, status, dry_run, error_message, started_at, finished_at)
                    VALUES ($1, 'failed', false, $2, now(), now())
                    ON CONFLICT (mbno) DO UPDATE SET status='failed', error_message=$2, finished_at=now()
                `, [mbno, e.message]);
            }
        } finally {
            await runner.release();
        }
    }

    console.log('\n\n===== SUMMARY =====');
    console.log(`Members processed: ${members.length}`);
    console.log(`Repayments replayed: ${totalRepayments}`);
    console.log(`Consolidations applied: ${totalConsolidations}`);
    console.log(`Flags raised: ${totalFlags}`);
    if (allFlags.length > 0) {
        console.log('\n--- Flags (review before trusting any live run) ---');
        for (const f of allFlags) console.log(`[${f.mbno}] ${f.flag}`);
    }

    await AppDataSource.destroy();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

// Exported so read-only analysis tooling can reuse the exact same attribution
// logic against bulk-fetched data (one SQL Server round trip for everything,
// instead of per-member sqlcmd calls) without duplicating — and risking
// silently diverging from — the real replay engine.
module.exports = { findConsolidationEvents, findPvoucherConsolidations, buildAttribution, round2 };
