import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RdRulesService } from '../rd-rules.service';
import { RdPatternEligibilityService } from './rd-pattern-eligibility.service';
import { PatternEvaluation, evaluateRdPaymentPattern, InstallmentRecord } from '../rd-pattern-engine';
import { calculateRdInstallmentInterest, RdInstallmentInterestResult } from '../rd-installment-interest-calculator';
import { calculateOpeningBalanceInterest, BalanceEventInput, OpeningBalanceInterestResult } from '../rd-opening-balance-interest';
import { loadRdCdMovements, loadRdCdOpening, loadRdInstallmentRows, loadDemandPostedMonths, localDateFromYmd, RdLedgerInputs, RdInstallmentRow } from '../rd-ledger-inputs';

export type RdDecision = 'ALLOW' | 'DENY';

export interface RdDecisionInfo {
    /** what the employee chose (null = nobody decided yet) */
    saved: RdDecision | null;
    reason: string | null;
    by: string | null;
    at: string | null;
    /** what will be posted: the saved choice, else Allow for a fully regular member while automatic posting is on, else Deny */
    effective: RdDecision;
    source: 'SAVED' | 'AUTO' | 'DEFAULT';
    /** the employee still has to choose: the pattern is not fully regular, nobody decided, and the two figures differ */
    needsDecision: boolean;
}

export interface RdInterestPreview {
    fullInterestEligible: boolean;
    installmentInterest: RdInstallmentInterestResult;
    openingBalanceInterest: OpeningBalanceInterestResult;
    /** Simple addition of the two independent totals — never a blended
     *  formula, per the user's explicit instruction that these stay
     *  independent calculators. */
    totalInterest: number;
}

export interface RdExplainMonth {
    label: string;
    dueDate: string;
    paidDate: string | null;
    amount: number;
    status: 'ON_TIME' | 'LATE' | 'MISSED' | 'NOT_POSTED';
    allowed: { months: number; interest: number };
    denied: { months: number; interest: number };
}

const PATTERN_LABEL: Record<string, string> = {
    FULLY_REGULAR: 'Fully regular',
    INITIAL_GAP_RECOVERED: 'Initial gap recovered',
    LATER_GAP_RECOVERED: 'Later gap recovered',
    MULTIPLE_GAPS: 'Multiple gaps',
    GAP_UNRECOVERED: 'Gap unrecovered',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const ym = (ymd: string) => Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(5, 7));

/** The pattern in plain words, for the calculation window. */
export function describePattern(p: PatternEvaluation, hasInstallmentRows: boolean): string {
    if (!hasInstallmentRows) return 'No instalment rows exist for this year (a migrated or payroll-only member). Each deposit in the ledger counts from the month it was received.';
    switch (p.detectedPattern) {
        case 'FULLY_REGULAR': return `Every instalment (${p.totalDue}) was paid in its due month.`;
        case 'INITIAL_GAP_RECOVERED': return `The year started with missed months that were paid later, then payments were regular. ${p.totalPaidLate} instalment(s) were paid late.`;
        case 'LATER_GAP_RECOVERED': return `Payments were regular, then a gap in the year was cleared late. ${p.totalPaidLate} instalment(s) were paid late.`;
        case 'MULTIPLE_GAPS': return `More than one separate gap in the year, each cleared late. ${p.totalPaidLate} instalment(s) were paid late.`;
        default: return `${p.totalStillMissing} instalment(s) were never paid${p.totalPaidLate ? ` and ${p.totalPaidLate} were paid late` : ''}.`;
    }
}

/**
 * Wires the two independent pure calculators (installment interest,
 * opening-balance interest) to the member's RD/CD LEDGER for one member+financial-year
 * (ES-581: see rd-ledger-inputs.ts), and combines their totals by plain addition only.
 * Used both by a preview endpoint here and by the financial-year-closing orchestrator
 * that persists the result and posts the yearly journal.
 *
 * ES-629 (owner decisions 2026-11-23):
 *  - Each instalment earns the society's PRINTED chart value for the months it stays in (see rd-interest-chart.ts).
 *  - The employee's decision changes only LATE instalments: ALLOW = counted from the due month, DENY = from the month paid.
 *    A member with no decision is DENIED, except that a fully regular member is allowed automatically while the Business Rule
 *    RULE_RD_AUTO_PATTERN_POSTING is on (the figure is the same either way).
 *  - The due month comes from rd_installment_ledger. A member without instalment rows (migrated) counts each ledger deposit in
 *    the month it was received, so the decision changes nothing for such a member.
 *  - The opening-balance interest never depends on the decision.
 */
@Injectable()
export class RdInterestCalculationService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly rdRules: RdRulesService,
        private readonly patternEligibility: RdPatternEligibilityService,
    ) { }

    async getFinancialYearEndDate(yearcode: number): Promise<Date> {
        const rows = await this.dataSource.query(
            `SELECT end_date FROM yearend WHERE yearcode = $1 LIMIT 1`,
            [yearcode],
        );
        if (!rows[0]?.end_date) throw new NotFoundException(`Financial year ${yearcode} not found or has no end date.`);
        return new Date(rows[0].end_date);
    }

    /** The year's first and last day as local YYYY-MM-DD strings. */
    async getFinancialYearBounds(yearcode: number): Promise<{ start: string; end: string }> {
        const rows = await this.dataSource.query(
            `SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM yearend WHERE yearcode = $1 LIMIT 1`,
            [yearcode],
        );
        if (!rows[0]?.s || !rows[0]?.e) throw new NotFoundException(`Financial year ${yearcode} not found or has no start / end date.`);
        return { start: String(rows[0].s), end: String(rows[0].e) };
    }

    /** Opening RD/CD balance of the year, deposits and withdrawals, all from the ledger. */
    async loadLedgerInputs(mbno: string, yearcode: number): Promise<RdLedgerInputs & { fyStart: string; fyEnd: string }> {
        const { start, end } = await this.getFinancialYearBounds(yearcode);
        const [opening, moves] = await Promise.all([
            loadRdCdOpening(this.dataSource, mbno, start),
            loadRdCdMovements(this.dataSource, mbno, start, end),
        ]);
        return { opening, deposits: moves.deposits, withdrawals: moves.withdrawals, fyStart: start, fyEnd: end };
    }

    /** The member's RD/CD balance at the start of the year (for the closing summary). */
    async getLedgerOpeningBalance(mbno: string, yearcode: number): Promise<number> {
        const { start } = await this.getFinancialYearBounds(yearcode);
        return loadRdCdOpening(this.dataSource, mbno, start);
    }

    // ── the employee's decision ─────────────────────────────────────────────────

    async loadDecisionRow(mbno: string, yearcode: number): Promise<{ decision: RdDecision; reason: string | null; by: string; at: string } | null> {
        try {
            const rows = await this.dataSource.query(
                `SELECT decision, reason, decided_by, to_char(decided_at, 'YYYY-MM-DD HH24:MI') AS at FROM rd_interest_decision WHERE mbno::numeric = $1::numeric AND yearcode = $2 LIMIT 1`,
                [mbno, yearcode],
            );
            const r = rows?.[0];
            return r ? { decision: r.decision as RdDecision, reason: r.reason ?? null, by: String(r.decided_by), at: String(r.at) } : null;
        } catch {
            return null; // the table does not exist yet: nobody decided anything
        }
    }

    /** Which figure will be posted for this member (saved choice, automatic, or the Deny default). */
    resolveDecision(row: { decision: RdDecision; reason: string | null; by: string; at: string } | null, autoOn: boolean, patternCode: string, figuresDiffer: boolean): RdDecisionInfo {
        if (row) return { saved: row.decision, reason: row.reason, by: row.by, at: row.at, effective: row.decision, source: 'SAVED', needsDecision: false };
        if (autoOn && patternCode === 'FULLY_REGULAR') return { saved: null, reason: null, by: null, at: null, effective: 'ALLOW', source: 'AUTO', needsDecision: false };
        return { saved: null, reason: null, by: null, at: null, effective: 'DENY', source: 'DEFAULT', needsDecision: patternCode !== 'FULLY_REGULAR' && figuresDiffer };
    }

    /** The decision that applies now, without the "figures differ" refinement (used where only the choice is needed). */
    async resolveEffective(mbno: string, yearcode: number, evaluation?: PatternEvaluation): Promise<RdDecisionInfo> {
        const [row, autoOn, pattern] = await Promise.all([
            this.loadDecisionRow(mbno, yearcode),
            this.rdRules.getRule('RULE_RD_AUTO_PATTERN_POSTING'),
            evaluation ? Promise.resolve(evaluation) : this.evaluatePattern(mbno, yearcode),
        ]);
        return this.resolveDecision(row, autoOn, pattern.detectedPattern, true);
    }

    // ── the two calculators ─────────────────────────────────────────────────────

    /**
     * The deposits that earn interest, month by month (ES-631):
     *  - a month with an instalment row uses the row (its due month and paid date); a month without one uses the ledger deposits
     *    of that month as paid on time (a ledger deposit of a month that has a row is the same payment and is not counted again);
     *  - a row made by the demand import counts only once that month's demand is POSTED to the ledger, until then it is listed as
     *    "imported, not posted" and earns nothing;
     *  - the same months feed the pattern engine.
     */
    private async depositItems(mbno: string, yearcode: number, inputs: RdLedgerInputs & { fyStart: string; fyEnd: string }) {
        const [rows, posted] = await Promise.all([
            loadRdInstallmentRows(this.dataSource, mbno, yearcode),
            loadDemandPostedMonths(this.dataSource, mbno, inputs.fyStart, inputs.fyEnd),
        ]);
        const hasRows = rows.length > 0;
        const fyMonths: string[] = [];
        const y0 = Number(inputs.fyStart.slice(0, 4)); const m0 = Number(inputs.fyStart.slice(5, 7));
        for (let i = 0; i < 12; i++) { const d = new Date(y0, m0 - 1 + i, 1); fyMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
        const rowsBy = new Map<string, RdInstallmentRow[]>();
        for (const r of rows) { const k = r.dueDate.slice(0, 7); (rowsBy.get(k) ?? rowsBy.set(k, []).get(k)!).push(r); }
        const depBy = new Map<string, Array<{ date: string; amount: number }>>();
        for (const d of inputs.deposits) { const k = d.date.slice(0, 7); (depBy.get(k) ?? depBy.set(k, []).get(k)!).push(d); }

        const items: Array<{ due: string; paid: string; amount: number }> = [];
        const missed: Array<{ due: string }> = [];
        const notPosted: Array<{ due: string; amount: number }> = [];
        const records: InstallmentRecord[] = [];
        for (const k of fyMonths) {
            const rws = rowsBy.get(k);
            if (rws && rws.length) {
                for (const r of rws) {
                    if (r.paidAmount > 0 && r.paidDate) {
                        if (/demand import/i.test(r.narration) && posted.get(k) !== true) { notPosted.push({ due: r.dueDate, amount: r.paidAmount }); continue; }
                        items.push({ due: r.dueDate, paid: r.paidDate, amount: r.paidAmount });
                        records.push({ dueDate: r.dueDate, expectedAmount: r.expectedAmount, paidAmount: r.paidAmount, paidDate: r.paidDate });
                    } else if (r.expectedAmount > 0) {
                        missed.push({ due: r.dueDate });
                        records.push({ dueDate: r.dueDate, expectedAmount: r.expectedAmount, paidAmount: 0, paidDate: null });
                    }
                }
            } else if (depBy.has(k)) {
                const deps = depBy.get(k)!;
                for (const d of deps) items.push({ due: d.date, paid: d.date, amount: d.amount });
                const sum = round2(deps.reduce((t, d) => t + d.amount, 0));
                records.push({ dueDate: `${k}-01`, expectedAmount: sum, paidAmount: sum, paidDate: deps[0].date });
            }
        }
        return { items, missed, notPosted, records, hasRows };
    }

    /** The payment pattern of the member's year, from the same months the interest uses (instalment rows and ledger deposits). */
    async evaluatePattern(mbno: string, yearcode: number): Promise<PatternEvaluation> {
        const inputs = await this.loadLedgerInputs(mbno, yearcode);
        const [{ records }, rules] = await Promise.all([this.depositItems(mbno, yearcode, inputs), this.rdRules.getAllRules()]);
        return evaluateRdPaymentPattern(records, rules);
    }

    private installmentResult(items: Array<{ due: string; paid: string; amount: number }>, rate: number, eligible: boolean, fyEnd: string) {
        return calculateRdInstallmentInterest(
            items.map((i) => ({ dueDate: localDateFromYmd(i.due), paidDate: localDateFromYmd(i.paid), paidAmount: i.amount })),
            rate,
            eligible,
            localDateFromYmd(fyEnd),
        );
    }

    /** Instalment interest. `eligible` = Allow (true) or Deny (false); omitted = the decision that applies to this member. */
    async calculateInstallmentInterest(mbno: string, yearcode: number, eligible?: boolean): Promise<RdInstallmentInterestResult> {
        const [inputs, rate] = await Promise.all([
            this.loadLedgerInputs(mbno, yearcode),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
        ]);
        const allow = eligible ?? (await this.resolveEffective(mbno, yearcode)).effective === 'ALLOW';
        const { items } = await this.depositItems(mbno, yearcode, inputs);
        return this.installmentResult(items, rate, allow, inputs.fyEnd);
    }

    async calculateOpeningBalanceInterest(mbno: string, yearcode: number): Promise<OpeningBalanceInterestResult> {
        const [inputs, rate] = await Promise.all([
            this.loadLedgerInputs(mbno, yearcode),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
        ]);
        return this.openingInterest(inputs, rate);
    }

    private openingInterest(inputs: RdLedgerInputs & { fyStart: string; fyEnd: string }, rate: number): OpeningBalanceInterestResult {
        // the opening balance, lowered by each withdrawal from the month it happens (a withdrawal takes effect at once)
        const events: BalanceEventInput[] = [];
        // ES-582 (owner decision): like the legacy, only a member with RD/CD movement during the year earns interest on the opening
        // balance. Checked against the legacy: it paid members whose only movement was a monthly debit (no deposit row), so a
        // movement of either kind counts, not only a deposit.
        if ((inputs.deposits.length > 0 || inputs.withdrawals.length > 0) && (inputs.opening > 0 || inputs.withdrawals.length > 0)) {
            events.push({ eventDate: localDateFromYmd(inputs.fyStart), eventType: 'OPENING', resultingBalance: Math.max(0, inputs.opening) });
            let running = Math.max(0, inputs.opening);
            for (const w of inputs.withdrawals) {
                running = Math.round((running - w.amount) * 100) / 100;
                events.push({ eventDate: localDateFromYmd(w.date), eventType: 'WITHDRAWAL', resultingBalance: running });
            }
        }
        const result = calculateOpeningBalanceInterest(events, rate, localDateFromYmd(inputs.fyEnd));
        // withdrawing money that was deposited this year can take the base below zero; it can only cancel interest, never pay a negative amount
        return { ...result, totalInterest: Math.max(0, result.totalInterest) };
    }

    /** Both figures at once (Allow and Deny), the opening interest being the same for both. */
    async calculateBothWays(mbno: string, yearcode: number): Promise<{ instAllowed: number; instDenied: number; opening: number }> {
        const [inputs, rate] = await Promise.all([this.loadLedgerInputs(mbno, yearcode), this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE')]);
        const { items } = await this.depositItems(mbno, yearcode, inputs);
        return {
            instAllowed: this.installmentResult(items, rate, true, inputs.fyEnd).totalInterest,
            instDenied: this.installmentResult(items, rate, false, inputs.fyEnd).totalInterest,
            opening: this.openingInterest(inputs, rate).totalInterest,
        };
    }

    /** Both independent figures for a member+year, combined only by simple
     *  addition — a preview of what financial-year closing would credit if
     *  run right now with the decision that applies (or the given override). */
    async previewTotalInterest(mbno: string, yearcode: number, overrideEligible?: boolean): Promise<RdInterestPreview> {
        const patternEvaluation = await this.evaluatePattern(mbno, yearcode);
        const effective = overrideEligible ?? (await this.resolveEffective(mbno, yearcode, patternEvaluation)).effective === 'ALLOW';
        const [installmentResult, openingResult] = await Promise.all([
            this.calculateInstallmentInterest(mbno, yearcode, effective),
            this.calculateOpeningBalanceInterest(mbno, yearcode),
        ]);

        return {
            fullInterestEligible: effective,
            installmentInterest: installmentResult,
            openingBalanceInterest: openingResult,
            totalInterest: Math.max(0, Math.round((installmentResult.totalInterest + openingResult.totalInterest) * 100) / 100),
        };
    }

    // ── past financial years (read-only) ─────────────────────────────────────────

    /** The financial years before the current one that the ledger has RD/CD money for, newest first. */
    async listHistoryYears(): Promise<Array<{ fyStartYear: number; label: string }>> {
        const [r] = await this.dataSource.query(`SELECT EXTRACT(YEAR FROM MIN(trans_date))::int AS y, EXTRACT(MONTH FROM MIN(trans_date))::int AS m FROM ledger WHERE TRIM(code) = 'L1004'`);
        const now = new Date();
        const currentStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
        if (!r?.y) return [];
        const firstStart = r.m >= 4 ? r.y : r.y - 1;
        const out: Array<{ fyStartYear: number; label: string }> = [];
        for (let y = currentStart - 1; y >= firstStart; y--) out.push({ fyStartYear: y, label: `Apr ${y} - Mar ${y + 1}` });
        return out;
    }

    /**
     * ES-629: how the RD/CD interest of a PAST financial year works out for one member (read-only: nothing is saved or posted).
     * Past years have no instalment rows (no due month), so each calendar month is one virtual instalment: paid when the ledger
     * has a deposit that month, otherwise not paid, counted from the member's first deposit month. The pattern engine runs on
     * those, the interest uses the real deposits and withdrawals, and the figure the legacy actually posted is shown beside it.
     */
    async explainHistory(mbno: string, fyStartYear: number) {
        const start = `${fyStartYear}-04-01`;
        const end = `${fyStartYear + 1}-03-31`;
        const [opening, moves, rate, rules] = await Promise.all([
            loadRdCdOpening(this.dataSource, mbno, start),
            loadRdCdMovements(this.dataSource, mbno, start, end),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
            this.rdRules.getAllRules(),
        ]);
        const inputs = { opening, deposits: moves.deposits, withdrawals: moves.withdrawals, fyStart: start, fyEnd: end };
        const fyMonths: string[] = [];
        for (let i = 0; i < 12; i++) { const d = new Date(fyStartYear, 3 + i, 1); fyMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
        const byMonth = new Map<string, { amount: number; first: string }>();
        for (const d of inputs.deposits) {
            const k = d.date.slice(0, 7);
            const cur = byMonth.get(k);
            byMonth.set(k, { amount: round2((cur?.amount ?? 0) + d.amount), first: cur && cur.first < d.date ? cur.first : d.date });
        }
        const firstIdx = fyMonths.findIndex((k) => byMonth.has(k));
        const used = firstIdx < 0 ? [] : fyMonths.slice(firstIdx);
        const amounts = used.map((k) => byMonth.get(k)?.amount ?? 0).filter((a) => a > 0).sort((a, b) => a - b);
        const typical = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
        const records: InstallmentRecord[] = used.map((k) => {
            const m = byMonth.get(k);
            return { dueDate: `${k}-01`, expectedAmount: m ? m.amount : typical, paidAmount: m ? m.amount : 0, paidDate: m ? m.first : null };
        });
        const pattern = evaluateRdPaymentPattern(records, rules);

        const items = inputs.deposits.map((d) => ({ due: d.date, paid: d.date, amount: d.amount }));
        const allowedRes = this.installmentResult(items, rate, true, end);
        const perMonthInterest = new Map<string, { interest: number; months: number }>();
        items.forEach((it, i) => {
            const k = it.paid.slice(0, 7);
            const cur = perMonthInterest.get(k) ?? { interest: 0, months: allowedRes.rows[i].remainingMonthsUsed };
            perMonthInterest.set(k, { interest: round2(cur.interest + allowedRes.rows[i].interest), months: cur.months });
        });
        const months: RdExplainMonth[] = used.map((k) => {
            const m = byMonth.get(k);
            const calc = perMonthInterest.get(k);
            const label = `${MONTH_NAMES[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
            const cell = { months: calc?.months ?? 0, interest: calc?.interest ?? 0 };
            return { label, dueDate: `${k}-01`, paidDate: m?.first ?? null, amount: m?.amount ?? 0, status: m ? 'ON_TIME' : 'MISSED', allowed: cell, denied: cell } as RdExplainMonth;
        });

        const opening2 = this.openingInterest(inputs, rate);
        const monthLabel = (d: Date) => `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
        const openingPeriods = opening2.periods
            .filter((p) => p.monthsHeld > 0)
            .map((p) => ({ from: monthLabel(p.fromDate), to: monthLabel(new Date(p.toDate.getFullYear(), p.toDate.getMonth() - 1, 1)), balance: p.balance, months: p.monthsHeld, interest: p.interest }));
        const inst = allowedRes.totalInterest;
        const total = round2(inst + opening2.totalInterest);

        const [member] = await this.dataSource.query(`SELECT COALESCE(full_name, '') AS n FROM member_master WHERE mbno::numeric = $1::numeric LIMIT 1`, [mbno]);
        const [legacy] = await this.dataSource.query(
            `SELECT COALESCE(SUM(trans_amt), 0)::float AS amt, to_char(MIN(trans_date), 'YYYY-MM-DD') AS d FROM ledger
              WHERE mbno::numeric = $1::numeric AND TRIM(code) = 'E1026' AND trans_type = 'DR'
                AND trans_date >= ($2::date - 7) AND trans_date < ($2::date + 2)`,
            [mbno, end],
        );
        const legacyAmount = Number(legacy?.amt || 0);
        const pat = {
            code: pattern.detectedPattern,
            label: PATTERN_LABEL[pattern.detectedPattern] ?? pattern.detectedPattern,
            summary: used.length === 0
                ? 'No RD/CD deposit in the ledger this year.'
                : `Worked out from the ledger: a month with a deposit counts as paid in its month, a month without one as not paid, from the member's first deposit month (${used.length} months). The legacy data has no due month, so a late payment cannot be told apart. ${describePattern(pattern, true)}`,
            reasons: pattern.disqualifyingReasons,
            totalDue: pattern.totalDue,
            paidOnTime: pattern.totalPaidOnTime,
            paidLate: pattern.totalPaidLate,
            missed: pattern.totalStillMissing,
            longestGapMonths: pattern.longestGapMonths,
            maxConsecutiveOnTime: pattern.maxConsecutiveOnTime,
        };
        return {
            mbno,
            memberName: member?.n ?? '',
            yearcode: null,
            fyStart: start,
            fyEnd: end,
            rate,
            monthlyAmount: typical || null,
            openingBalance: inputs.opening,
            mode: 'HISTORY',
            historic: true,
            pattern: pat,
            months,
            openingInterest: round2(opening2.totalInterest),
            openingBreakdown: { rate, periods: openingPeriods, withdrawals: inputs.withdrawals.map((w) => ({ date: w.date, amount: w.amount })) },
            totals: { installmentAllowed: inst, installmentDenied: inst, totalAllowed: total, totalDenied: total },
            decision: { saved: null, reason: null, by: null, at: null, effective: 'DENY' as RdDecision, source: 'DEFAULT' as const, needsDecision: false },
            autoPostingOn: false,
            closed: null,
            legacyPosted: { amount: round2(legacyAmount), date: legacy?.d ?? null, difference: round2(total - legacyAmount) },
        };
    }

    /** Everything the one-member calculation window shows: the pattern and its reason, the month-by-month table with both
     *  figures, the totals, the decision and whether the year is already closed. Read-only. */
    async explain(mbno: string, yearcode: number) {
        const [inputs, rate, rules, autoOn, decisionRow] = await Promise.all([
            this.loadLedgerInputs(mbno, yearcode),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
            this.rdRules.getAllRules(),
            this.rdRules.getRule('RULE_RD_AUTO_PATTERN_POSTING'),
            this.loadDecisionRow(mbno, yearcode),
        ]);
        const { items, missed, notPosted, records, hasRows } = await this.depositItems(mbno, yearcode, inputs);
        const pattern = evaluateRdPaymentPattern(records, rules);
        const allowedRes = this.installmentResult(items, rate, true, inputs.fyEnd);
        const deniedRes = this.installmentResult(items, rate, false, inputs.fyEnd);

        const months: RdExplainMonth[] = items.map((it, i) => {
            const a = allowedRes.rows[i];
            const d = deniedRes.rows[i];
            return {
                label: `${MONTH_NAMES[Number(it.due.slice(5, 7)) - 1]} ${it.due.slice(0, 4)}`,
                dueDate: it.due,
                paidDate: it.paid,
                amount: it.amount,
                status: ym(it.paid) <= ym(it.due) ? 'ON_TIME' : 'LATE',
                allowed: { months: a.remainingMonthsUsed, interest: a.interest },
                denied: { months: d.remainingMonthsUsed, interest: d.interest },
            } as RdExplainMonth;
        });
        for (const m of missed) {
            months.push({ label: `${MONTH_NAMES[Number(m.due.slice(5, 7)) - 1]} ${m.due.slice(0, 4)}`, dueDate: m.due, paidDate: null, amount: 0, status: 'MISSED', allowed: { months: 0, interest: 0 }, denied: { months: 0, interest: 0 } });
        }
        for (const n of notPosted) {
            months.push({ label: `${MONTH_NAMES[Number(n.due.slice(5, 7)) - 1]} ${n.due.slice(0, 4)}`, dueDate: n.due, paidDate: null, amount: n.amount, status: 'NOT_POSTED', allowed: { months: 0, interest: 0 }, denied: { months: 0, interest: 0 } });
        }
        months.sort((x, y) => x.dueDate.localeCompare(y.dueDate));

        const opening = this.openingInterest(inputs, rate);
        // the periods the opening-balance interest is made of: each balance and the whole months it stayed at that level
        const monthLabel = (d: Date) => `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
        const openingPeriods = opening.periods
            .filter((p) => p.monthsHeld > 0)
            .map((p) => ({
                from: monthLabel(p.fromDate),
                to: monthLabel(new Date(p.toDate.getFullYear(), p.toDate.getMonth() - 1, 1)),
                balance: p.balance,
                months: p.monthsHeld,
                interest: p.interest,
            }));
        const instAllowed = allowedRes.totalInterest;
        const instDenied = deniedRes.totalInterest;
        const totalAllowed = round2(instAllowed + opening.totalInterest);
        const totalDenied = round2(instDenied + opening.totalInterest);
        const decision = this.resolveDecision(decisionRow, autoOn, pattern.detectedPattern, Math.abs(totalAllowed - totalDenied) > 0.004);

        const [member] = await this.dataSource.query(`SELECT COALESCE(full_name, '') AS n FROM member_master WHERE mbno::numeric = $1::numeric LIMIT 1`, [mbno]);
        const [cfg] = await this.dataSource.query(
            `SELECT monthly_rd_amount::float AS a FROM rd_member_config WHERE mbno::numeric = $1::numeric AND yearcode = $2 ORDER BY effective_from_date DESC, id DESC LIMIT 1`,
            [mbno, yearcode],
        );
        const [closed] = await this.dataSource.query(
            `SELECT total_interest_credited::float AS t, to_char(closed_at, 'YYYY-MM-DD HH24:MI') AS at, closed_by FROM rd_financial_year_summary WHERE mbno::numeric = $1::numeric AND yearcode = $2 AND closed_at IS NOT NULL LIMIT 1`,
            [mbno, yearcode],
        );

        return {
            mbno,
            memberName: member?.n ?? '',
            yearcode,
            fyStart: inputs.fyStart,
            fyEnd: inputs.fyEnd,
            rate,
            monthlyAmount: cfg?.a ?? null,
            openingBalance: inputs.opening,
            mode: hasRows ? 'INSTALMENTS' : 'LEDGER',
            pattern: {
                code: pattern.detectedPattern,
                label: PATTERN_LABEL[pattern.detectedPattern] ?? pattern.detectedPattern,
                summary: describePattern(pattern, hasRows || records.length > 0) + (notPosted.length ? ` ${notPosted.length} imported month(s) are not posted to the ledger yet and are not counted until they are posted.` : ''),
                reasons: pattern.disqualifyingReasons,
                totalDue: pattern.totalDue,
                paidOnTime: pattern.totalPaidOnTime,
                paidLate: pattern.totalPaidLate,
                missed: pattern.totalStillMissing,
                longestGapMonths: pattern.longestGapMonths,
                maxConsecutiveOnTime: pattern.maxConsecutiveOnTime,
            },
            months,
            openingInterest: round2(opening.totalInterest),
            openingBreakdown: { rate, periods: openingPeriods, withdrawals: inputs.withdrawals.map((w) => ({ date: w.date, amount: w.amount })) },
            totals: { installmentAllowed: instAllowed, installmentDenied: instDenied, totalAllowed, totalDenied },
            decision,
            autoPostingOn: autoOn,
            closed: closed ? { totalInterestCredited: closed.t, closedAt: closed.at, closedBy: closed.closed_by } : null,
        };
    }
}
