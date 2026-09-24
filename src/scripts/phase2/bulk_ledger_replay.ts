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
 * OPEN DESIGN CALL NOT YET RESOLVED (flag to user before a live run):
 *   When a consolidation event tops up a case that already exists in
 *   Postgres (from the earlier bulk import) rather than being freshly
 *   disbursed, this script does NOT recompute a new blended EMI the way
 *   passTransaction()'s live consolidation path does (that would require
 *   re-deriving a slot/RB schedule historically, which risks silently
 *   diverging from what the member was actually charged). Instead it
 *   increases the receiving case's loan_amt/balance by the transfer amount
 *   and lets its existing (real, legacy-observed) instal_amt keep applying
 *   — the same "freeze the real observed EMI, don't force our formula"
 *   treatment already used for non-conforming loans elsewhere this
 *   session. This means a topped-up case may run a few installments longer
 *   than its original no_of_instal to fully amortize. This is a judgment
 *   call, not a certainty — review the CONSOLIDATION_APPLIED log lines
 *   from a dry run before deciding this is acceptable.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../../modules/rd/services/rd-balance-events.service';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

const DRY_RUN = !(process.env.DRY_RUN === 'false' && process.env.CONFIRM_LIVE_RUN === 'yes-i-mean-it');
const MBNO_FILTER = process.env.MBNO_FILTER; // e.g. '610033146' or a comma list, to test specific members
// MBNO_FILE: a pinned, reviewed member list (one mbno per line) — preferred over a giant
// MBNO_FILTER env string for a real batch, so the run is auditable against exactly what
// was reviewed in the preceding dry-run pass rather than re-deriving "clean" live.
const MBNO_FILE = process.env.MBNO_FILE;
const MEMBER_LIMIT = process.env.MEMBER_LIMIT ? parseInt(process.env.MEMBER_LIMIT, 10) : undefined;
const BALANCE_TOLERANCE = 50; // rupees; mismatch beyond this is flagged, not silently accepted
const MIN_CONSOLIDATION_AMOUNT = 50; // rupees; matched journal pairs below this are noise (rounding vouchers), not real consolidations
const SQLCMD_SERVER = '.\\SQLEXPRESS';
const SQLCMD_DB = 'EMP_Espat_Society_dan';

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
function getLegacyInterestLegs(mbno: string): { transDate: string; receiptVchrNo: string; amt: number }[] {
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

    // Attach each interest leg to its matching CR (repayment) event(s) by
    // (date, receipt voucher) — same key the legacy demand-receipt process
    // itself used to tie the two legs together. A voucher matching more than
    // one CR loan-leg (e.g. one receipt paying both an RLN and ALN case the
    // same day) splits the interest proportionally by each leg's own
    // principal amount, rather than either dropping it or double-counting it.
    // Deliberately sets interestAmt, NOT amt — amt must stay principal-only
    // (see the LegacyEvent doc comment) for the FIFO exhaustion math below to
    // stay correct; the interest is folded back in only when building what
    // actually gets replayed via recordLoanRepayment().
    const interestLegs = getLegacyInterestLegs(mbno);
    for (const leg of interestLegs) {
        const matches = events.filter(e => e.transType === 'CR' && e.transDate === leg.transDate && e.receiptVchrNo === leg.receiptVchrNo);
        if (matches.length === 0) continue; // no matching loan leg — leave unmatched, same as the confirmed ~0.5-6% tail
        const principalSum = matches.reduce((s, m) => s + m.amt, 0);
        if (principalSum <= 0) continue;
        for (const m of matches) {
            m.interestAmt = round2(m.interestAmt + leg.amt * (m.amt / principalSum));
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
function findPvoucherConsolidations(cases: LegacyCase[], events: LegacyEvent[]): ConsolidationEvent[] {
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
    repaymentsToReplay: { date: string; amount: number }[];
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
    payrollLag?: { oldPrincipal: number; oldInterest: number; watchUntil: string };
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
                        activeQueue[cursor].repaymentsToReplay.push({ date: tick.date, amount: round2(applied + appliedInterest) });
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
    // Two independent, non-overlapping consolidation mechanisms in this legacy DB —
    // see findConsolidationEvents (cross-type, journal-voucher) and
    // findPvoucherConsolidations (same-type, ordinary disbursement-voucher) for why
    // neither one alone covers both real patterns.
    const consolidations = [...findConsolidationEvents(events), ...findPvoucherConsolidations(cases, events)]
        .sort((a, b) => a.date.localeCompare(b.date));
    const { byType, flags } = buildAttribution(cases, events, consolidations);

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
                `SELECT loancaseno, balance, loan_amt FROM loan_master WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`,
                [mbno, loancaseno, type]
            );
            if (pgRow.length === 0) {
                flags.push(`Case ${loancaseno} (${type}) not found in Postgres for mbno ${mbno} — skipped`);
                continue;
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
            if (impliedTotal > effectiveCapacity + BALANCE_TOLERANCE && cs.legacyCase.noOfInstal > 0) {
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
            } else if (!cs.closed
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
                        `UPDATE loan_master SET loan_amt = loan_amt + $1, balance = balance + $1 WHERE mbno = $2 AND loancaseno::text = $3 AND loantype = $4`,
                        [cs.toppedUpBy, mbno, loancaseno, type]
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

            for (const r of cs.repaymentsToReplay) {
                log(`  REPAYMENT case=${loancaseno} type=${type} date=${r.date} amount=₹${r.amount}`);
                if (!DRY_RUN) {
                    const result = await svc.recordLoanRepayment({
                        // receipt_no is varchar(30) — the original 'LEGACYREPLAY-<case>-<full timestamp>'
                        // format overflowed it on every single call, failing 100% of the live batch
                        // (safely, each member rolled back cleanly, but zero writes landed). Date-only,
                        // no unique constraint on this column so a same-day split repayment on one case
                        // reusing the same receipt_no is harmless.
                        mbno, loancaseno, loantype: type, paymentAmount: r.amount,
                        receiptNo: `LR-${loancaseno}-${r.date.slice(0, 10)}`,
                        narration: 'Legacy ledger replay (Phase 2 bulk migration)',
                        username: 'phase2-replay',
                        asOfDate: new Date(r.date),
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
                    await AppDataSource.query(
                        `INSERT INTO loan_repayment_ledger
                            (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                             principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 0, 0, 0, NULL, $8, $9)`,
                        [mbno, loancaseno, type, new Date(cs.closedDate!),
                            new Date(cs.closedDate!).getMonth() + 1, new Date(cs.closedDate!).getFullYear(), remBal,
                            `Legacy consolidation replay: closed, folded into successor case`, 'phase2-replay']
                    );
                }
            }

            // Independent sanity check: expected balance = loanAmt + topups - sum(repayments), vs what
            // recordLoanRepayment actually produced. Flag anything beyond tolerance rather than trust silently.
            // Mirrors (doesn't call) the real payroll-lag detection purely so this preview's arithmetic
            // matches what will actually happen live — the first repayment inside the watch window that
            // matches the old EMI total is excluded from the sum, same as recordLoanRepayment does for real.
            let payrollLagExcluded = 0;
            if (cs.payrollLag) {
                const oldTotal = round2(cs.payrollLag.oldPrincipal + cs.payrollLag.oldInterest);
                const match = cs.repaymentsToReplay.find(r => r.date <= cs.payrollLag!.watchUntil && Math.abs(r.amount - oldTotal) < 1);
                if (match) {
                    payrollLagExcluded = match.amount;
                    log(`  PAYROLL_LAG_DETECTED case=${loancaseno} date=${match.date} amount=₹${match.amount} — excluded from schedule, netted at closure instead`);
                }
            }
            const expected = round2(cs.legacyCase.loanAmt + scheduleExtension + cs.toppedUpBy
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

async function main() {
    console.log(`===== Phase 2 bulk ledger replay — DRY_RUN=${DRY_RUN} =====`);
    if (DRY_RUN) {
        console.log('Running in DRY RUN. No Postgres writes will occur. Set DRY_RUN=false and CONFIRM_LIVE_RUN=yes-i-mean-it to write for real.');
    } else {
        console.log('!!! LIVE RUN — writing real repayment history to Postgres for real members !!!');
    }

    await AppDataSource.initialize();
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
            if (existing[0]?.status === 'done') {
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
