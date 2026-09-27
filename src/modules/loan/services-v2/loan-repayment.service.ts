import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { LoanEligibilityService } from './loan-eligibility.service';
import { RdBalanceEventsService } from '../../rd/services/rd-balance-events.service';
import { LoanRoundingMode, LOAN_ROUNDING_MODES, applyLoanRounding, round2 } from './loan-rb-schedule.util';

export interface RepaymentDto {
    mbno: string;
    loancaseno: string;
    /** No longer used to target a payment — kept for backward compatibility
     *  with existing callers. Recovery order is always oldest-unpaid-first,
     *  decided server-side from loan_repayment_ledger history. */
    paymentMonth?: number;
    paymentYear?: number;
    paymentAmount: number;
    receiptNo?: string;
    narration?: string;
    username?: string;
    /** Test-only clock override for simulating "today" during penal/overdue
     *  verification. The controller strips this outside non-production
     *  environments, so a real client can never backdate/forward-date an
     *  actual money-moving write. Omit in every real call; defaults to the
     *  real clock. */
    asOfDate?: Date;
    /** Optional disambiguator for the rare case where loancaseno collides
     *  across loan types for the same member (233 real members found this
     *  session — a legacy migration artifact, not a real duplicate case).
     *  Purely additive: omitted, this behaves exactly as before (picks
     *  whichever row the DB returns first, same as every existing caller
     *  including the live frontend). Passed, it disambiguates the initial
     *  read so a caller that already knows which type it means (like the
     *  Phase 2 replay script) can't be handed the wrong loan's balance. */
    loantype?: string;
    /** Explicit component replay used by the legacy separate-interest migration. */
    principalAmount?: number;
    interestAmount?: number;
    penalAmount?: number;
    /**
     * True only for the predecessor-loan EMI that was deducted after a
     * consolidation. It remains auditable in the ledger but must not reduce
     * this successor loan's balance or installment pools.
     */
    isPayrollLagCredit?: boolean;
}

/** Which of the three penal tiers an installment currently sits in. */
type PenalTier = 0 | 1 | 2;

interface InstallmentStatus {
    installmentNo: number;
    dueDate: Date;
    monthlyPrincipal: number;
    monthlyInterest: number;
    principalPaid: number;
    interestPaid: number;
    principalDue: number;
    interestDue: number;
    /** Complete calendar months elapsed since the due month ended. 0 during tiers 0/1. */
    monthsOverdue: number;
    tier: PenalTier;
    penalDue: number;
    isFullyPaid: boolean;
    /** False for a genuinely future installment (only present when
     *  getInstallmentStatus was called with includeFuture) — interest and
     *  penal are never charged on these, only principal (prepayment) can
     *  apply. */
    isDue: boolean;
}

interface LoanScheduleVersion {
    effective_date: string | Date;
    first_due_month: string | Date;
    opening_principal: string | number;
    monthly_principal: string | number;
    installment_count: string | number;
    monthly_installment: string | number;
    annual_rate: string | number;
    delay_months: string | number;
    version_no: string | number;
    source: string;
}

/** Real number of days in a given month (year, 0-indexed month). */
function daysInMonth(year: number, month0: number): number {
    return new Date(year, month0 + 1, 0).getDate();
}

/**
 * Formats a Date as a plain YYYY-MM-DD string using its LOCAL calendar date —
 * never `.toISOString().split('T')[0]`, which converts to UTC first. In a
 * server running in a timezone ahead of UTC (IST, +5:30), that conversion
 * shifts a local midnight back across the day boundary, so a due date
 * genuinely built as "the 1st of the month" was being displayed as "the
 * 30th/31st of the previous month" — the underlying tier/penal math was
 * never affected (it never reads this string), only what got shown.
 */
function toLocalDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * The three-tier grace/penal rule, evaluated once per installment. Both
 * getInstallmentStatus() below and executeEarlyClosure()'s separate
 * duplicated loop call this exact function, so the two code paths (the quote
 * calculateEarlyClosure shows an operator, and what executeEarlyClosure
 * actually commits) can never disagree.
 *
 * Interest is NEVER prorated by day anywhere in this system — it's a flat
 * monthly charge the instant an installment's month begins, same as the
 * equalised-interest design used everywhere else in this codebase. Grace
 * only ever decides whether/how much PENAL gets added on top of that flat
 * interest — never whether the interest itself is charged:
 *
 *   Tier 0 (day 1..graceDay of the due month):       no penal
 *   Tier 1 (graceDay+1..month end, same due month):   flat one-time fee =
 *                                                      (smPct% × principalDue) ÷ smDivisor
 *   Tier 2 (any day in a later month):                principalDue × (penalRate/100/12) × monthsOverdue —
 *                                                      a whole-month step, flat all month, jumps only on the 1st
 *
 * graceDay is clamped to the due month's actual last day, so a grace value
 * of (say) 31 configured on a loan type doesn't spill into the next month
 * just because the due month only has 28, 29 or 30 days.
 */
function computeTier(
    principalDue: number,
    isFullyPaid: boolean,
    dueDate: Date,
    asOfDate: Date,
    graceDayOfMonth: number,
    penalRateAnnual: number,
    sameMonthPenalPct: number,
    sameMonthPenalDivisor: number,
): { tier: PenalTier; monthsOverdue: number; penalDue: number } {
    if (isFullyPaid) return { tier: 0, monthsOverdue: 0, penalDue: 0 };

    const dueYear = dueDate.getFullYear();
    const dueMonth0 = dueDate.getMonth();
    const monthsOverdue = Math.max(
        0,
        (asOfDate.getFullYear() - dueYear) * 12 + (asOfDate.getMonth() - dueMonth0)
    );

    if (monthsOverdue > 0) {
        const penalDue = penalRateAnnual > 0
            ? Math.round(principalDue * (penalRateAnnual / 100 / 12) * monthsOverdue * 100) / 100
            : 0;
        return { tier: 2, monthsOverdue, penalDue };
    }

    const cutoff = Math.min(graceDayOfMonth, daysInMonth(dueYear, dueMonth0));
    if (asOfDate.getDate() <= cutoff) {
        return { tier: 0, monthsOverdue: 0, penalDue: 0 };
    }

    const penalDue = sameMonthPenalPct > 0 && sameMonthPenalDivisor > 0
        ? Math.round(((sameMonthPenalPct / 100) * principalDue / sameMonthPenalDivisor) * 100) / 100
        : 0;
    return { tier: 1, monthsOverdue: 0, penalDue };
}

interface LoanPenaltyPolicy {
    enabled: boolean;
    annualRate: number;
    activationDate: Date | null;
}

@Injectable()
export class LoanRepaymentService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly loanEligibility: LoanEligibilityService,
        private readonly rdBalanceEvents: RdBalanceEventsService,
    ) {}

    private async getLoanPenaltyPolicy(runner: DataSource | QueryRunner): Promise<LoanPenaltyPolicy> {
        const configRows = await runner.query(
            `SELECT key, value FROM system_configs
             WHERE key = ANY($1) AND "isActive" = true`,
            [['RULE_TIERED_LOAN_PENALTY_ENABLED', 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE']],
        );
        const businessRuleRows = await runner.query(
            `SELECT rlnpenalrate FROM busrules ORDER BY appdate DESC LIMIT 1`,
        );
        const config = new Map<string, string>(configRows.map((row: any) => [row.key, String(row.value)]));
        const enabledValue = config.get('RULE_TIERED_LOAN_PENALTY_ENABLED')?.toLowerCase();
        const enabled = enabledValue === 'true' || enabledValue === '1' || enabledValue === 'y';
        const activationText = config.get('RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE');
        const activationDate = activationText ? new Date(`${activationText.slice(0, 10)}T00:00:00`) : null;
        const parsedRate = Number(businessRuleRows[0]?.rlnpenalrate);
        return {
            enabled,
            // The global RULE_PENAL_RATE maps to busrules.rlnpenalrate and is
            // intentionally authoritative across all loan types. loan_master's
            // penalrate remains a historical origination-time snapshot.
            annualRate: Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 0,
            activationDate: activationDate && !Number.isNaN(activationDate.getTime()) ? activationDate : null,
        };
    }

    /**
     * Builds the month-by-month installment schedule for a loan using the
     * equalised-interest method (constant principal + constant interest),
     * and reconciles it against what's already been recorded in
     * loan_repayment_ledger. By default, only installments whose due month
     * has started on or before `asOfDate` are included, oldest first.
     *
     * This is the single source of truth for "what's actually still owed,
     * per installment" — oldest-first recovery order, the early-closure
     * quote, AND (via includeFuture) early closure's actual execution all
     * share this exact same pooling logic now, so they can never disagree
     * with each other about which installments are paid. (executeEarlyClosure
     * used to keep its own separate, month-bucketed implementation of this —
     * a real structural risk that this unification removes: money paid
     * against a loan is fungible and pooled here regardless of which
     * calendar month a payment happened to be tagged with, so a payment
     * mistagged to the wrong month, or covering more than one installment in
     * a single row, is still credited correctly either way.)
     *
     * @param includeFuture When true, keeps going past the "due" boundary and
     *   returns every remaining installment through noOfInstal — needed by
     *   early closure, which must settle (or at least principal-prepay) every
     *   installment, not just the ones already due. Future rows never carry
     *   interest or penal (isDue: false) — only principal can be prepaid
     *   against them, same rule as before.
     */
    private async getCurrentScheduleVersion(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        loan: any,
        asOfDate: Date,
    ): Promise<LoanScheduleVersion | null> {
        const rows = await runner.query(
            `SELECT effective_date, first_due_month, opening_principal, monthly_principal,
                    installment_count, monthly_installment, annual_rate, delay_months, version_no, source
             FROM loan_schedule_versions
             WHERE mbno = $1 AND loantype = $2 AND loancaseno::text = $3
               AND effective_date <= $4::date
             ORDER BY effective_date DESC, version_no DESC
             LIMIT 1`,
            [loan.mbno, loan.loantype, loancaseno, asOfDate],
        );
        return rows[0] ?? null;
    }

    private firstDueMonthStart(version: LoanScheduleVersion): Date {
        const dueMonth = new Date(version.first_due_month);
        return new Date(dueMonth.getFullYear(), dueMonth.getMonth(), 1);
    }

    private async getVersionPrincipalPaid(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        mbno: string,
        loantype: string,
        asOfDate: Date,
        version: LoanScheduleVersion,
    ): Promise<number> {
        const rows = await runner.query(
            `SELECT COALESCE(SUM(principal_amount), 0) AS paid
             FROM loan_repayment_ledger
             WHERE loancaseno = $1 AND mbno = $2 AND loantype = $3 AND payment_date <= $4
             AND payment_date >= $5 AND is_payroll_lag_credit = false`,
            [loancaseno, mbno, loantype, asOfDate, version.effective_date],
        );
        return round2(parseFloat(rows[0]?.paid) || 0);
    }

    /**
     * Principal in a BSP payroll-lag row belongs to the predecessor EMI, so
     * it cannot settle/count a successor installment. If it was collected
     * after the current agreement became effective, however, it is money
     * already recovered against the consolidated exposure and must reduce
     * the successor's closure principal exactly once. Earlier lag rows are
     * already reflected in the new agreement's opening-principal snapshot.
     */
    private async getPayrollLagPrincipalOffset(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        loan: any,
        asOfDate: Date,
        version: LoanScheduleVersion | null,
    ): Promise<number> {
        const effectiveDate = version?.effective_date ?? loan.payment_date;
        const rows = await runner.query(
            `SELECT COALESCE(SUM(principal_amount), 0) AS principal_offset
             FROM loan_repayment_ledger
             WHERE loancaseno = $1 AND mbno = $2 AND loantype = $3 AND payment_date <= $4
               AND payment_date >= $5::date AND is_payroll_lag_credit = true`,
            [loancaseno, loan.mbno, loan.loantype, asOfDate, effectiveDate],
        );
        return round2(parseFloat(rows[0]?.principal_offset) || 0);
    }

    private async getInstallmentStatus(
        queryRunner: QueryRunner,
        loancaseno: string,
        loan: any,
        asOfDate: Date = new Date(),
        includeFuture: boolean = false,
    ): Promise<InstallmentStatus[]> {
        const scheduleVersion = await this.getCurrentScheduleVersion(queryRunner, loancaseno, loan, asOfDate);
        const loanAmt = scheduleVersion ? parseFloat(String(scheduleVersion.opening_principal)) : (parseFloat(loan.loan_amt) || 0);
        const noOfInstal = scheduleVersion ? parseInt(String(scheduleVersion.installment_count), 10) : (parseInt(loan.no_of_instal, 10) || 0);
        const instalAmt = scheduleVersion ? parseFloat(String(scheduleVersion.monthly_installment)) : (parseFloat(loan.instal_amt) || 0);
        const penaltyPolicy = await this.getLoanPenaltyPolicy(queryRunner);
        const penalRateAnnual = penaltyPolicy.annualRate;
        const graceDayOfMonth = parseInt(loan.gracedays, 10) || 0;
        const sameMonthPenalPct = parseFloat(loan.smpenalpct) || 0;
        const sameMonthPenalDivisor = parseFloat(loan.smpenaldiv) || 0;
        const disbursementDate = scheduleVersion ? new Date(scheduleVersion.effective_date) : new Date(loan.payment_date);
        // Slot delay months, frozen onto this loan at disbursement (see
        // pass-transaction.service.ts) — NULL on any loan disbursed before
        // this column existed, treated as 0 (no schedule shift), preserving
        // this system's original behavior for those older loans.
        const delayMonths = scheduleVersion ? parseInt(String(scheduleVersion.delay_months), 10) : (parseInt(loan.delay_months, 10) || 0);

        if (noOfInstal <= 0 || isNaN(disbursementDate.getTime())) return [];

        let monthlyPrincipal = scheduleVersion
            ? parseFloat(String(scheduleVersion.monthly_principal))
            : loanAmt / noOfInstal;
        // A loan's interest is always the reducing-balance schedule interest.
        // Migrated loans may have no reconstructed schedule; those fall back
        // to the legacy installment split (which is zero for principal-only
        // migrated loans).
        const totalInterest = Math.max(0, instalAmt * noOfInstal - loanAmt);
        let fallbackMonthlyInterest = scheduleVersion
            ? Math.max(0, instalAmt - monthlyPrincipal)
            : totalInterest / noOfInstal;
        const rbInterestRows = await queryRunner.query(
            `SELECT installment_no, rb_interest FROM loan_rb_schedule
             WHERE mbno = $1 AND loantype = $2 AND loancaseno::text = $3`,
            [loan.mbno, loan.loantype, loancaseno],
        );
        const rbInterestByInstallment = new Map<number, number>(
            rbInterestRows.map((r: any) => [
                Number(r.installment_no), Math.round((parseFloat(r.rb_interest) || 0) * 100) / 100,
            ]),
        );

        // Principal and interest are matched as cumulative pools drawn down in
        // installment order, not bucketed by the calendar month a payment
        // happened to land in. Money paid against a loan is fungible: a
        // prepayment tagged with the same month as a scheduled installment used
        // to over-credit that installment while leaving a later one showing a
        // balance the member had in fact already cleared.
        // Only money actually received on or before asOfDate counts. Without
        // this the pools would include later payments, so asking what a member
        // owed at some past date would answer using rupees they had not yet
        // paid — every historical arrear silently reading as settled.
        // is_payroll_lag_credit rows are deliberately excluded here — see
        // AddPayrollLagCredit1758900000000's doc comment. That money never
        // applied against any installment of THIS loan (it's the closed-out
        // predecessor's last EMI, still working through BSP's payroll
        // pipeline), so it must never enter the pool that decides which
        // installments are paid.
        // mbno-scoped alongside loancaseno — loancaseno collides across
        // members in this schema (see calculateEarlyClosure's comment), so
        // without this an unrelated member's ledger rows sharing the same
        // case number would leak into this loan's principal/interest pools.
        const totalsRow = await queryRunner.query(
            `SELECT COALESCE(SUM(principal_amount), 0) as principal_paid,
                    COALESCE(SUM(interest_amount), 0) as interest_paid
             FROM loan_repayment_ledger
             WHERE loancaseno = $1 AND mbno = $2 AND loantype = $3 AND payment_date <= $4 AND is_payroll_lag_credit = false
               AND ($5::date IS NULL OR payment_date >= $5)`,
            [loancaseno, loan.mbno, loan.loantype, asOfDate, scheduleVersion ? this.firstDueMonthStart(scheduleVersion) : null]
        );
        let principalPool = parseFloat(totalsRow[0]?.principal_paid) || 0;
        let interestPool = parseFloat(totalsRow[0]?.interest_paid) || 0;

        // Legacy separate-interest loans post a fixed whole-rupee principal
        // EMI (₹8,333 for ₹5,00,000/60), rather than the fractional result of
        // loan_amt/no_of_instal. Use the dominant observed principal amount
        // for migrated histories so the schedule does not invent a residual
        // ₹18.33 on the penultimate installment.
        if (!scheduleVersion && loan.loan_payment_model === 'SEPARATE_INTEREST') {
            const observed = await queryRunner.query(
                `SELECT principal_amount, COUNT(*)::int AS frequency
                 FROM loan_repayment_ledger
                 WHERE loancaseno = $1 AND mbno = $2 AND loantype = $3
                   AND payment_date <= $4 AND is_payroll_lag_credit = false
                   AND principal_amount > 0
                 GROUP BY principal_amount
                 ORDER BY frequency DESC, principal_amount DESC LIMIT 1`,
                [loancaseno, loan.mbno, loan.loantype, asOfDate],
            );
            const observedPrincipal = parseFloat(observed[0]?.principal_amount);
            if (Number.isFinite(observedPrincipal) && observedPrincipal > 0) {
                monthlyPrincipal = observedPrincipal;
                fallbackMonthlyInterest = Math.max(0, instalAmt - monthlyPrincipal);
            }
        }

        // One penalty per installment, ever — this society's policy is that
        // Tier 1 and Tier 2 are mutually exclusive outcomes for a given
        // installment, decided by whenever it actually gets paid, never both
        // charged on the same installment. computeTier() itself already
        // guarantees that for an installment evaluated for the first time
        // (it checks "later month" before "same month", so a fresh
        // installment can only ever land on one tier). But recovery order is
        // penal → interest → principal (see recordLoanRepayment below), so a
        // flat-EMI payment that included a Tier 1/2 fee always leaves that
        // same installment's principal a few rupees short — and without this
        // guard, that leftover crumb would be seen as a brand-new "principal,
        // now overdue" case next month and earn a second, smaller penalty of
        // its own, even though this exact installment was already penalized
        // once. Once any penalty has actually been recorded against a due
        // month, no further penalty is ever computed for that same due
        // month's remaining principal, no matter how long it's still short.
        const penalizedMonthsRows = await queryRunner.query(
            `SELECT DISTINCT payment_month, payment_year FROM loan_repayment_ledger
             WHERE loancaseno = $1 AND mbno = $2 AND loantype = $3 AND payment_date <= $4 AND penal_amount > 0`,
            [loancaseno, loan.mbno, loan.loantype, asOfDate],
        );
        const alreadyPenalizedMonths = new Set<string>(
            penalizedMonthsRows.map((r: any) => `${r.payment_month}-${r.payment_year}`),
        );

        // Recovery order is penal → interest → principal, so principal is always
        // the last rupee collected. Full principal recovery therefore means
        // everything ever charged has been settled — whether the loan ran its
        // full term or was closed early with the unearned interest waived.
        // Without this, an early-closed loan keeps reporting that waived future
        // interest as outstanding, and a normally-completed one reports a few
        // paise of per-installment rounding as still owed. Both read to the
        // member as money due on an account they have already cleared.
        const SETTLEMENT_TOLERANCE = 1; // rupee — absorbs per-installment rounding
        const isSettled = loanAmt > 0 && principalPool >= loanAmt - SETTLEMENT_TOLERANCE;

        // Fungible from here on: some loans' ledger rows split a payment
        // between principal_amount/interest_amount differently than this
        // formula's own monthlyPrincipal/monthlyInterest (e.g. a rounder
        // historical principal figure, or a lump-sum prepayment recorded
        // 100% as principal) — but the TOTAL cash paid per installment still
        // equals instalAmt exactly. Walking principalPool and interestPool
        // as two independently-capped pools treated that relabeling as a
        // real shortfall on whichever leg came up short, even though
        // nothing is actually owed. Pooling them into one fungible balance
        // and spending it against instalAmt (principal share first, then
        // interest) as a single unit means only a genuine shortfall in the
        // combined total — never a pure split/labeling difference — shows
        // up as still owed below.
        // Separate-interest loans use principal cash to advance principal
        // installments. Their separately posted I1002-style interest must not
        // prepay future principal slots.
        // Reducing balance is the only supported method. Principal and
        // interest remain separate pools so interest cannot prepay principal.
        let principalRemaining = principalPool;
        let interestRemaining = interestPool;

        const asOfYear = asOfDate.getFullYear();
        const asOfMonth0 = asOfDate.getMonth();
        const result: InstallmentStatus[] = [];

        for (let n = 1; n <= noOfInstal; n++) {
            const dueDate = new Date(disbursementDate);
            // Slot 1/2 already charges 1/2 extra months of interest (folded
            // into instal_amt at disbursement) to cover the real processing
            // gap before salary-deduction recovery can start — delayMonths
            // pushes the actual collection schedule back by that same gap,
            // so the member is never billed for a delay their due dates
            // don't reflect.
            dueDate.setMonth(dueDate.getMonth() + n + delayMonths);
            // In this cooperative's model, due date and grace period are the
            // same concept: the due date's DAY is the configured grace day
            // (clamped to that month's real length, never below 1) — not the
            // disbursement day. Only the month keeps following the
            // disbursement anniversary. Doesn't change computeTier's own
            // penalty decision below (it never reads dueDate's day, only its
            // month) — this only fixes what gets displayed/stored as "due
            // date" so it finally matches what actually decides the penalty.
            dueDate.setDate(Math.max(1, Math.min(graceDayOfMonth, daysInMonth(dueDate.getFullYear(), dueDate.getMonth()))));

            // Month-granular "has this installment's month started" check —
            // a deliberate business rule, not a day-count. Interest in this
            // system is a flat monthly charge, never day-prorated, so an
            // installment becomes due for the whole of its month starting
            // day 1, regardless of the exact disbursement-anniversary day the
            // schedule happens to assign it. (This supersedes an exact-date
            // check made earlier in this same session for a different,
            // narrower problem — that fix predates this business rule.)
            const monthsAhead = (dueDate.getFullYear() - asOfYear) * 12 + (dueDate.getMonth() - asOfMonth0);
            const isDue = monthsAhead <= 0;

            // A not-yet-due installment can still be fully prepaid — EMIs in
            // this system routinely land 1-2 months ahead of their formula
            // due date. If the payment pool already covers this
            // installment's full principal AND interest, it must still be
            // counted here — otherwise this loop's own installment count
            // (k, used for futureInstallmentCount below) undercounts
            // relative to outstandingPrincipal (computed independently from
            // the ledger sum), and the two desync by exactly one
            // installment's principal per installment paid ahead of
            // schedule. That desync corrupts computeApClosureInterest's
            // average-principal math: firstOpening (from outstandingPrincipal)
            // and the future installment count stop describing
            // the same remaining schedule.
            // Tolerance scales with n, not a fixed SETTLEMENT_TOLERANCE:
            // real payments are stored rounded to the rupee's cent, while
            // monthlyPrincipal is recomputed fresh from loanAmt/noOfInstal
            // every time — for some loans that's a genuine fixed
            // per-installment gap of several paise, not just floating-point
            // noise, and it compounds with every consecutive prepaid
            // installment consumed below. Scaling by n keeps the check tight
            // early (when a real principal shortfall should still be caught)
            // while growing exactly as fast as the cumulative rounding gap
            // it needs to absorb.
            //
            // Tolerance scales with n — see the fungible-pool comment above
            // for why a flat cent-level tolerance eventually fails for a
            // loan paid far enough ahead of schedule.
            const prepaidTolerance = SETTLEMENT_TOLERANCE * n;
            const scheduledPrincipal = scheduleVersion && n === noOfInstal
                ? round2(loanAmt - monthlyPrincipal * (noOfInstal - 1))
                : monthlyPrincipal;
            const monthlyInterest = rbInterestByInstallment.get(n) ?? fallbackMonthlyInterest;
            const isPrepaidAhead = !isDue && principalRemaining >= scheduledPrincipal - prepaidTolerance;

            if (!isDue && !isPrepaidAhead && !includeFuture) break; // due month hasn't started yet, and nothing prepaid to cover it

            // Spend the fungible pool against this installment's full
            // instalAmt as one unit — principal share first (this loan's
            // normal recovery convention), whatever's left toward interest.
            // isSettled/isPrepaidAhead already establish "close enough" via
            // the tolerances above, so the tiny sub-tolerance residue left
            // by rounding is swept to 0 rather than misreading a genuinely
            // settled installment as unpaid.
            const principalApplied = Math.min(scheduledPrincipal, principalRemaining);
            principalRemaining -= principalApplied;
            const interestApplied = (isDue || isPrepaidAhead)
                ? Math.min(monthlyInterest, interestRemaining)
                : 0;
            interestRemaining -= interestApplied;
            const paid = {
                principal: Math.round(principalApplied * 100) / 100,
                interest: Math.round(interestApplied * 100) / 100,
            };
            const principalDue = isSettled || isPrepaidAhead
                ? 0
                : Math.max(0, Math.round((scheduledPrincipal - principalApplied) * 100) / 100);

            // Interest and penal are never charged on a month that hasn't
            // started yet — a genuinely future (not prepaid) installment can
            // only ever be principal-prepaid, so no interest is drawn from
            // the pool for it (computeTier is never called for it either;
            // asOfDate necessarily precedes its due month, so a tier
            // comparison would be meaningless). A prepaid-ahead installment
            // still draws interest from the pool below, same as a due one,
            // since it's already been established as settled overall — just
            // never gets a tier/penal computed, since that block stays gated
            // on isDue alone.
            let interestDue = 0;
            let tier: PenalTier = 0;
            let monthsOverdue = 0;
            let penalDue = 0;
            if (isDue || isPrepaidAhead) {
                interestDue = isSettled || isPrepaidAhead
                    ? 0
                    : Math.max(0, Math.round((monthlyInterest - interestApplied) * 100) / 100);
            }

            const isFullyPaid = principalDue <= 0 && interestDue <= 0;

            // Apply the same configured tiers to migrated and newly originated
            // loans. The activation-date anchor prevents backdating penalties
            // on older arrears while avoiding a dependency on RB schedule rows.
            if (isDue && penaltyPolicy.enabled && penaltyPolicy.activationDate && asOfDate >= penaltyPolicy.activationDate) {
                // Existing overdue loans begin accruing penalties at the
                // explicit activation date, with no retroactive tier months.
                const penaltyDueDate = dueDate < penaltyPolicy.activationDate
                    ? penaltyPolicy.activationDate
                    : dueDate;
                const tierResult = computeTier(
                    principalDue, isFullyPaid, penaltyDueDate, asOfDate,
                    graceDayOfMonth, penalRateAnnual, sameMonthPenalPct, sameMonthPenalDivisor,
                );
                tier = tierResult.tier;
                monthsOverdue = tierResult.monthsOverdue;
                // This due month already had a penalty charged against it in
                // an earlier visit — don't charge a second one on whatever
                // principal crumb that earlier penalty's own collection left
                // behind. See the alreadyPenalizedMonths note above.
                const alreadyPenalized = alreadyPenalizedMonths.has(`${dueDate.getMonth() + 1}-${dueDate.getFullYear()}`);
                penalDue = alreadyPenalized ? 0 : tierResult.penalDue;
            }

            result.push({
                installmentNo: n,
                dueDate,
                monthlyPrincipal: Math.round(scheduledPrincipal * 100) / 100,
                monthlyInterest: Math.round(monthlyInterest * 100) / 100,
                principalPaid: paid.principal,
                interestPaid: paid.interest,
                principalDue,
                interestDue,
                monthsOverdue,
                tier,
                penalDue,
                isFullyPaid,
                isDue,
            });
        }

        return result;
    }

    /**
     * Records a repayment against a loan, always recovering the oldest unpaid
     * installment first — an operator cannot pay a later month while an
     * earlier one is still outstanding (the loan calculation spec's recovery
     * rule). Cascades through as many installments as the payment covers;
     * any amount left over after every due installment is cleared is applied
     * against future, not-yet-due installments one at a time, each split
     * between principal and interest in the same ratio as the loan's own EMI
     * (see BUG FIX 40 below for why an even split matters, not just a plain
     * principal prepayment).
     */
    async recordLoanRepayment(dto: RepaymentDto): Promise<{ success: boolean; message: string }> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // mbno-scoped when the caller supplies it — loancaseno collides
            // across members in this schema (see calculateEarlyClosure's
            // matching comment), so an unscoped lookup can post a real
            // repayment against a different member's loan. loantype-scoped
            // too when the caller supplies it — loancaseno also collides
            // across loan types WITHIN a member (233 real members, a legacy
            // migration artifact); omitted, this is unchanged from before.
            const whereParts = ['loancaseno::text = $1'];
            const params: any[] = [dto.loancaseno];
            if (dto.mbno) { params.push(dto.mbno); whereParts.push(`mbno = $${params.length}`); }
            if (dto.loantype) { params.push(dto.loantype); whereParts.push(`loantype = $${params.length}`); }
            const loanRows = await queryRunner.query(
                `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv,
                        payment_date, delay_months, payroll_lag_watch_until, payroll_lag_old_principal, payroll_lag_old_interest, loan_payment_model
                 FROM loan_master WHERE ${whereParts.join(' AND ')}`,
                params
            );
            if (loanRows.length === 0) {
                throw new BadRequestException(`Loan case ${dto.loancaseno} not found in loan_master${dto.mbno ? ` for member ${dto.mbno}` : ''}`);
            }
        const loan = loanRows[0];
        const asOf = dto.asOfDate && !isNaN(dto.asOfDate.getTime()) ? dto.asOfDate : new Date();
        const repaymentTotals = await this.getLedgerHistoryTotals(queryRunner, dto.loancaseno, asOf, loan.mbno, loan.loantype);
        const scheduleVersion = await this.getCurrentScheduleVersion(
            queryRunner, dto.loancaseno, loan, asOf,
        );
        // For a consolidated loan, its active schedule opening is the balance
        // at that boundary. Cumulative loan_amt includes predecessor exposure
        // and cannot reconstruct that balance when earlier payroll-lag
        // principal was excluded from the installment ledger. Later lag rows
        // remain separate closure offsets and do not count as current-loan EMI.
        const currentBalance = scheduleVersion
            ? Math.max(0, round2(
                parseFloat(String(scheduleVersion.opening_principal))
                - await this.getVersionPrincipalPaid(
                    queryRunner, dto.loancaseno, loan.mbno, loan.loantype, asOf, scheduleVersion,
                ),
            ))
            : repaymentTotals.totalPayrollLagPrincipal > 0
                ? Math.max(0, round2((parseFloat(loan.loan_amt) || 0) - repaymentTotals.totalPrincipalPaid))
                : (parseFloat(loan.balance || 0));
        const payment = parseFloat(dto.paymentAmount as any);

            if (payment <= 0) throw new BadRequestException('Payment amount must be greater than zero');
            // A predecessor payroll-lag credit is an audit receipt, not a
            // repayment against this loan. BSP can deliver it after the
            // current loan's principal has already been settled, so it must
            // still be recordable without reopening/changing the loan balance.
            if (currentBalance <= 0 && dto.isPayrollLagCredit !== true) {
                throw new BadRequestException(`Loan ${dto.loancaseno} is already fully repaid`);
            }

        // Legacy separate-interest replay: preserve the source system's
        // principal/interest classification exactly. This branch is explicit
        // so ordinary live repayments keep their existing allocation path.
        if (dto.principalAmount !== undefined) {
            const principal = round2(Math.max(0, Number(dto.principalAmount) || 0));
            const interest = round2(Math.max(0, Number(dto.interestAmount) || 0));
            const penal = round2(Math.max(0, Number(dto.penalAmount) || 0));
            const isPayrollLagCredit = dto.isPayrollLagCredit === true;
            const total = round2(principal + interest + penal);
            if (total <= 0) throw new BadRequestException('Explicit repayment components must total more than zero');
            await queryRunner.query(
                `INSERT INTO loan_repayment_ledger
                    (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                     principal_amount, interest_amount, penal_amount, months_overdue,
                     receipt_no, narration, posted_by, is_payroll_lag_credit)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14)`,
                [dto.mbno, dto.loancaseno, loan.loantype, asOf,
                    asOf.getMonth() + 1, asOf.getFullYear(), total,
                    principal, interest, penal, dto.receiptNo || null,
                    dto.narration || 'Legacy separate-interest repayment', dto.username || 'system',
                    isPayrollLagCredit]
            );
            // A predecessor-loan payroll-lag row belongs to the old loan's
            // collection, not this successor loan's principal. Keep the
            // receipt as an explicitly flagged audit row, but do not reduce
            // this loan's balance or installment schedule with it.
            if (!isPayrollLagCredit) {
                const newBalance = Math.max(0, round2(currentBalance - principal));
                await queryRunner.query(
                    `UPDATE loan_master SET balance = $1 WHERE loancaseno::text = $2 AND mbno = $3 AND loantype = $4`,
                    [newBalance, dto.loancaseno, dto.mbno, loan.loantype]
                );
            }
            await queryRunner.commitTransaction();
            return {
                success: true,
                message: isPayrollLagCredit
                    ? `Recorded payroll-lag credit ₹${total}; excluded from the current-loan balance and installments.`
                    : `Recorded separate principal ₹${principal} and interest ₹${interest}.`,
            };
        }

            // Automatic payroll-lag credit detection — see
            // AddPayrollLagCredit1758900000000 and pass-transaction.service.ts's
            // arming logic. If this loan consolidated an existing loan, BSP's
            // payroll system keeps deducting the OLD EMI for up to
            // payroll_lag_watch_until while it catches up to the new one. A
            // payment landing inside that window, for exactly the old EMI's
            // principal+interest, is that stray deduction — not a real payment
            // against this loan's own schedule. Recorded as its own flagged
            // row and returned immediately, skipping the normal oldest-unpaid
            // loop entirely, so it never pools against this loan's
            // installments. Only the FIRST such match is ever auto-detected
            // (checked via the existing is_payroll_lag_credit flag below) —
            // exactly one extra old-rate cycle is ever expected.
            const watchUntil = loan.payroll_lag_watch_until ? new Date(loan.payroll_lag_watch_until) : null;
            if (watchUntil && !isNaN(watchUntil.getTime()) && asOf <= watchUntil) {
                const oldPrincipal = parseFloat(loan.payroll_lag_old_principal) || 0;
                const oldInterest = parseFloat(loan.payroll_lag_old_interest) || 0;
                const oldTotal = Math.round((oldPrincipal + oldInterest) * 100) / 100;
                if (oldTotal > 0 && Math.abs(payment - oldTotal) < 1) {
                    const alreadyFlagged = await queryRunner.query(
                        `SELECT 1 FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3 AND is_payroll_lag_credit = true LIMIT 1`,
                        [dto.loancaseno, dto.mbno, loan.loantype]
                    );
                    if (alreadyFlagged.length === 0) {
                        await queryRunner.query(
                            `INSERT INTO loan_repayment_ledger
                                (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                                 principal_amount, interest_amount, penal_amount, months_overdue,
                                 receipt_no, narration, posted_by, is_payroll_lag_credit)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12,true)`,
                            [
                                dto.mbno, dto.loancaseno, loan.loantype, asOf,
                                asOf.getMonth() + 1, asOf.getFullYear(), payment,
                                oldPrincipal, oldInterest,
                                dto.receiptNo || null,
                                `Auto-detected payroll-lag credit — old loan's EMI, still in BSP's payroll pipeline, `
                                + `kept as a predecessor-loan receipt; not applied to this loan's principal or schedule`,
                                dto.username || 'system',
                            ]
                        );
                        await queryRunner.commitTransaction();
                        return {
                            success: true,
                            message: `Recognized as the old loan's payroll-lag EMI (₹${oldPrincipal.toLocaleString('en-IN')} `
                                + `principal + ₹${oldInterest.toLocaleString('en-IN')} interest) — recorded as an automatic `
                                + `predecessor-loan receipt; excluded from this loan's principal balance and installments.`,
                        };
                    }
                }
            }

            const installments = await this.getInstallmentStatus(queryRunner, dto.loancaseno, loan, asOf);
            const unpaid = installments.filter(i => !i.isFullyPaid);

            let remaining = payment;
            let totalPrincipalApplied = 0;
            let totalInterestApplied = 0;
            let totalPenalApplied = 0;
            const installmentsCovered: number[] = [];

            for (const inst of unpaid) {
                if (remaining <= 0) break;

                const penalPaid = Math.round(Math.min(remaining, inst.penalDue) * 100) / 100;
                remaining -= penalPaid;
                const interestPaid = Math.round(Math.min(remaining, inst.interestDue) * 100) / 100;
                remaining -= interestPaid;
                const principalCap = Math.min(inst.principalDue, currentBalance - totalPrincipalApplied);
                const principalPaid = Math.round(Math.min(remaining, principalCap) * 100) / 100;
                remaining -= principalPaid;

                if (penalPaid <= 0 && interestPaid <= 0 && principalPaid <= 0) continue;

                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue,
                         receipt_no, narration, posted_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                    [
                        dto.mbno, dto.loancaseno, loan.loantype, asOf,
                        inst.dueDate.getMonth() + 1, inst.dueDate.getFullYear(),
                        Math.round((principalPaid + interestPaid + penalPaid) * 100) / 100,
                        principalPaid, interestPaid, penalPaid, inst.monthsOverdue,
                        dto.receiptNo || null,
                        dto.narration || `Loan Repayment - Installment #${inst.installmentNo}`,
                        dto.username || 'system'
                    ]
                );

                await queryRunner.query(
                    `UPDATE demand_master
                     SET balance_for_month = GREATEST(0, balance_for_month - $1)
                     WHERE mbno = $2 AND demand_for_month = $3 AND demand_for_year = $4`,
                    [principalPaid + interestPaid, dto.mbno, inst.dueDate.getMonth() + 1, inst.dueDate.getFullYear()]
                );

                totalPrincipalApplied += principalPaid;
                totalInterestApplied += interestPaid;
                totalPenalApplied += penalPaid;
                installmentsCovered.push(inst.installmentNo);
            }

            // Anything left after every due installment is cleared represents
            // paying ahead of schedule — money against future, not-yet-due
            // installments. Applied one future installment at a time, each
            // slice split between THAT installment's own principal and
            // interest in the same ratio as its EMI (never principal-only).
            //
            // BUG FIX 40: this used to post the entire leftover as pure
            // principal (interest_amount hardcoded to 0). getInstallmentStatus
            // draws principal and interest from two independent pools,
            // consumed per-installment — so a future installment ended up
            // with its principal pool fully drained while its interest pool
            // never received anything. When that installment's month
            // eventually arrived, it showed principalDue: 0 but interestDue
            // still fully outstanding — and since tier/penal is computed off
            // principalDue (already zero), no penal ever accrued on that
            // unpaid interest, no matter how many months overdue it became.
            // Confirmed live: advance-paying 4 EMIs on a fresh Rs.1,00,000/
            // 12-installment loan left Rs.2,833 of interest permanently
            // penalty-exempt across installments #1-4 (8-11 months overdue,
            // all reading penalDue: 0). Splitting each advance rupee by the
            // EMI's own principal:interest ratio keeps both pools draining in
            // lockstep, so an installment only reads "fully paid" once both
            // its principal AND interest are genuinely collected.
            if (remaining > 0.004 && totalPrincipalApplied < currentBalance) {
                const noOfInstal = parseInt(loan.no_of_instal, 10) || 0;
                const loanAmtNum = parseFloat(loan.loan_amt) || 0;
                const instalAmtNum = parseFloat(loan.instal_amt) || 0;
                const monthlyPrincipal = noOfInstal > 0 ? loanAmtNum / noOfInstal : 0;
                const totalInterestAll = Math.max(0, instalAmtNum * noOfInstal - loanAmtNum);
                const monthlyInterest = noOfInstal > 0 ? totalInterestAll / noOfInstal : 0;

                let nextInstallmentNo = installments.length + 1;
                while (remaining > 0.004 && totalPrincipalApplied < currentBalance && nextInstallmentNo <= noOfInstal) {
                    // Principal is still capped at whatever's actually left of
                    // the outstanding balance (e.g. the loan's final
                    // installment may owe less than a full monthlyPrincipal),
                    // so this never drives the balance below zero even when
                    // the payment amount would otherwise cover more.
                    const principalRoom = Math.round((currentBalance - totalPrincipalApplied) * 100) / 100;
                    const principalCap = Math.min(monthlyPrincipal, principalRoom);
                    const emiTotal = principalCap + monthlyInterest;
                    const slice = Math.min(remaining, emiTotal);
                    const principalPortion = emiTotal > 0 ? Math.round(slice * (principalCap / emiTotal) * 100) / 100 : 0;
                    const interestPortion = Math.round((slice - principalPortion) * 100) / 100;
                    if (principalPortion <= 0 && interestPortion <= 0) break;

                    const dueDate = new Date(loan.payment_date);
                    dueDate.setMonth(dueDate.getMonth() + nextInstallmentNo);

                    await queryRunner.query(
                        `INSERT INTO loan_repayment_ledger
                            (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                             principal_amount, interest_amount, penal_amount, months_overdue,
                             receipt_no, narration, posted_by)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, $10, $11, $12)`,
                        [
                            dto.mbno, dto.loancaseno, loan.loantype, asOf,
                            dueDate.getMonth() + 1, dueDate.getFullYear(),
                            Math.round((principalPortion + interestPortion) * 100) / 100,
                            principalPortion, interestPortion,
                            dto.receiptNo || null,
                            dto.narration || `Advance Payment (toward installment #${nextInstallmentNo})`,
                            dto.username || 'system'
                        ]
                    );
                    totalPrincipalApplied += principalPortion;
                    totalInterestApplied += interestPortion;
                    remaining -= (principalPortion + interestPortion);
                    nextInstallmentNo++;
                }
            }

            if (totalPrincipalApplied <= 0 && totalInterestApplied <= 0 && totalPenalApplied <= 0) {
                throw new BadRequestException(
                    `No outstanding dues found for loan ${dto.loancaseno} up to the current month — nothing to apply this payment against.`
                );
            }

            const newBalance = Math.max(0, currentBalance - totalPrincipalApplied);
            // mbno-scoped — same reasoning as executeEarlyClosure's matching
            // balance write: without it, a case-number collision could apply
            // this payment's balance reduction to the wrong member's loan.
            // ALSO loantype-scoped: loancaseno is not unique even within one
            // member (confirmed live on 233 real members — the original bulk
            // legacy migration reused a single sequential counter across RLN
            // and ALN). Without this, an UPDATE matching both rows silently
            // overwrote a same-numbered sibling case's balance with this
            // loan's own computed value on every single repayment — caught
            // only after it had already corrupted 27 members' data during
            // the Phase 2 replay.
            await queryRunner.query(
                `UPDATE loan_master SET balance = $1 WHERE loancaseno::text = $2 AND mbno = $3 AND loantype = $4`,
                [newBalance, dto.loancaseno, dto.mbno, loan.loantype]
            );

            // BUG FIX 39 (same defect as pass-transaction.service.ts BUG FIX 37, found separately
            // here since this service never shared that fix): tested only 'ELN', but ALN is the
            // loan type every real loan in this system uses. Confirmed live on real test data —
            // after a ₹2,132 repayment on an ALN loan, member_balances.emergency_loan_balance was
            // still the full disbursed amount (regularloan was decremented instead, floored at 0
            // by GREATEST since it started there) while loan_master.balance had correctly dropped.
            // A member who fully repays an ALN loan would show its full original amount against
            // their emergency-loan eligibility forever, since nothing ever brings it back down.
            const isEmergency = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes((loan.loantype || '').toUpperCase())
                || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
            if (isEmergency) {
                await queryRunner.query(
                    `UPDATE member_balances SET emergency_loan_balance = GREATEST(0, COALESCE(emergency_loan_balance, 0) - $1) WHERE mbno = $2`,
                    [totalPrincipalApplied, dto.mbno]
                );
            } else {
                await queryRunner.query(
                    `UPDATE member_balances SET regularloan = GREATEST(0, COALESCE(regularloan, 0) - $1) WHERE mbno = $2`,
                    [totalPrincipalApplied, dto.mbno]
                );
            }

            await queryRunner.commitTransaction();

            const totalApplied = Math.round((totalPrincipalApplied + totalInterestApplied + totalPenalApplied) * 100) / 100;
            const installmentNote = installmentsCovered.length > 0
                ? ` Covered installment(s) #${installmentsCovered.join(', ')}.`
                : '';
            const penalNote = totalPenalApplied > 0 ? ` Includes ₹${totalPenalApplied.toLocaleString('en-IN')} penal interest.` : '';
            const unusedNote = remaining > 0.01 ? ` ₹${remaining.toFixed(2)} was not applied (would overpay the loan).` : '';

            return {
                success: true,
                message: `Repayment of ₹${totalApplied.toLocaleString('en-IN')} recorded for loan ${dto.loancaseno}.${installmentNote}${penalNote} Remaining balance: ₹${newBalance.toLocaleString('en-IN')}.${unusedNote}`
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * How closure figures are rounded — RULE_LOAN_ROUNDING_MODE, the same
     * setting that rounds the constant monthly interest when an EMI is sized
     * (see loan-rb-schedule.util.ts). Read straight from system_configs rather
     * than through SystemConfigService so this service keeps its current
     * dependencies. Defaults to NEAREST (half-up at the rupee), matching the
     * society's manual closure worksheets.
     */
    private async getRoundingMode(runner: DataSource | QueryRunner): Promise<LoanRoundingMode> {
        const rows = await runner.query(
            `SELECT value FROM system_configs WHERE key = 'RULE_LOAN_ROUNDING_MODE' AND "isActive" = true LIMIT 1`,
        );
        const configured = rows[0]?.value;
        return LOAN_ROUNDING_MODES.includes(configured) ? configured : 'NEAREST';
    }

    /**
     * Historical totals actually recorded in loan_repayment_ledger, up to and
     * including asOfDate — the ledger-truth source for both outstanding
     * principal and interest reconciliation, per the user's explicit
     * early-closure spec: never derive outstanding principal from remaining
     * EMI amounts, and never rewrite/recalculate historical payments.
     */
    /**
     * Cross-checks the general ledger (real transaction history, migrated
     * from legacy or posted live) against loan_repayment_ledger before
     * quoting or executing an early closure. getInstallmentStatus and
     * getLedgerHistoryTotals only ever read loan_repayment_ledger — for a
     * migrated member whose Phase 2 repayment replay hasn't reached this
     * loan yet, that table is empty even though real repayments exist, so
     * closure would otherwise silently quote against the full original
     * principal (discovered live on case 17466: ledger showed 34 real
     * receipts, loan_repayment_ledger had zero rows, quote came back
     * ₹2,64,534 against a real ₹45,000 balance). Scoped to
     * trans_date >= this case's own disbursement date so an older,
     * unrelated same-type case for the same member (loancaseno collides
     * across cases in this schema) can't trigger a false positive.
     */
    private async assertLedgerReconciled(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        loan: { mbno: string; loantype: string; payment_date: Date | string },
    ): Promise<void> {
        const LEDGER_RECONCILE_TOLERANCE = 100; // rupees — absorbs payroll-lag netting/rounding

        const [ledgerRow] = await runner.query(
            `SELECT COALESCE(SUM(trans_amt), 0) as total FROM ledger
             WHERE mbno = $1 AND acc_type = $2 AND trans_type = 'CR' AND trans_date >= $3`,
            [loan.mbno, loan.loantype, loan.payment_date],
        );
        const realPaid = parseFloat(ledgerRow?.total ?? '0');
        if (realPaid <= LEDGER_RECONCILE_TOLERANCE) return;

        const [recordedRow] = await runner.query(
            `SELECT COALESCE(SUM(payment_amount), 0) as total FROM loan_repayment_ledger
             WHERE mbno = $1 AND loantype = $2`,
            [loan.mbno, loan.loantype],
        );
        const recordedPaid = parseFloat(recordedRow?.total ?? '0');

        if (realPaid - recordedPaid > LEDGER_RECONCILE_TOLERANCE) {
            throw new BadRequestException(
                `Loan ${loancaseno}: the ledger shows ₹${realPaid.toFixed(2)} already repaid on this account, but only `
                + `₹${recordedPaid.toFixed(2)} is recorded in this system's repayment history. This loan's repayment `
                + `records have not been fully migrated/reconciled yet — early closure cannot be quoted or executed `
                + `until that is resolved. Contact an administrator.`,
            );
        }
    }

    /**
     * Full consolidation lineage for a loan case, both directions — cases it
     * absorbed (walk consolidated_into_loancaseno backwards: any case that
     * points AT this one) and, if this case was itself later closed into
     * another, what it rolled into. Built for the Early Closure screen so an
     * operator can see a loan's full history in one place instead of it
     * being invisible (the field already existed on loan_master — this is
     * the first place that surfaces it to the UI as a real timeline).
     */
    private async getConsolidationHistory(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        mbno: string,
        loantype: string,
    ): Promise<{
        absorbedCases: Array<{ loancaseno: string; loantype: string; originalLoanAmt: number; closedBalance: number; closureDate: string | null }>;
        consolidatedIntoLoancaseno: string | null;
    }> {
        const absorbed = await runner.query(
            `SELECT lm.loancaseno, lm.loantype, lm.loan_amt,
                    COALESCE((SELECT payment_amount FROM loan_repayment_ledger lrl
                              WHERE lrl.loancaseno = lm.loancaseno::text AND lrl.mbno = lm.mbno
                              ORDER BY lrl.payment_date DESC LIMIT 1), 0) as closed_balance,
                    (SELECT payment_date FROM loan_repayment_ledger lrl
                     WHERE lrl.loancaseno = lm.loancaseno::text AND lrl.mbno = lm.mbno
                     ORDER BY lrl.payment_date DESC LIMIT 1) as closure_date
             FROM loan_master lm
             WHERE lm.mbno = $1 AND lm.consolidated_into_loancaseno::text = $2
             ORDER BY lm.payment_date`,
            [mbno, loancaseno],
        );
        const own = await runner.query(
            `SELECT consolidated_into_loancaseno FROM loan_master WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`,
            [mbno, loancaseno, loantype],
        );
        return {
            absorbedCases: absorbed.map((r: any) => ({
                loancaseno: r.loancaseno,
                loantype: r.loantype,
                originalLoanAmt: round2(parseFloat(r.loan_amt) || 0),
                closedBalance: round2(parseFloat(r.closed_balance) || 0),
                closureDate: r.closure_date ? toLocalDateString(new Date(r.closure_date)) : null,
            })),
            consolidatedIntoLoancaseno: own[0]?.consolidated_into_loancaseno ?? null,
        };
    }

    /** Every real repayment recorded against this case — so an operator can
     *  see what actually happened instead of re-deriving it from totals. */
    private async getRepaymentHistory(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        mbno: string,
        loantype: string,
    ): Promise<Array<{ date: string; amount: number; principal: number; interest: number; penal: number; receiptNo: string | null; narration: string | null; isPayrollLagCredit: boolean }>> {
        const rows = await runner.query(
            `SELECT payment_date, payment_amount, principal_amount, interest_amount, penal_amount, receipt_no, narration, is_payroll_lag_credit
             FROM loan_repayment_ledger WHERE mbno = $1 AND loantype = $2 AND loancaseno = $3 ORDER BY payment_date`,
            [mbno, loantype, loancaseno],
        );
        return rows.map((r: any) => ({
            date: toLocalDateString(new Date(r.payment_date)),
            amount: round2(parseFloat(r.payment_amount) || 0),
            principal: round2(parseFloat(r.principal_amount) || 0),
            interest: round2(parseFloat(r.interest_amount) || 0),
            penal: round2(parseFloat(r.penal_amount) || 0),
            receiptNo: r.receipt_no,
            narration: r.narration,
            isPayrollLagCredit: r.is_payroll_lag_credit === true,
        }));
    }

    /** The reducing-balance amortization schedule built at disbursement —
     *  the actual month-by-month plan this loan is running against. */
    private async getRbSchedule(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        mbno: string,
        loantype: string,
    ): Promise<Array<{ installmentNo: number; openingBalance: number; rbInterest: number; principal: number; closingBalance: number }>> {
        const rows = await runner.query(
            `SELECT installment_no, opening_balance, rb_interest, principal, closing_balance
             FROM loan_rb_schedule WHERE mbno = $1 AND loantype = $2 AND loancaseno = $3 ORDER BY installment_no`,
            [mbno, loantype, loancaseno],
        );
        return rows.map((r: any) => ({
            installmentNo: r.installment_no,
            openingBalance: round2(parseFloat(r.opening_balance) || 0),
            rbInterest: round2(parseFloat(r.rb_interest) || 0),
            principal: round2(parseFloat(r.principal) || 0),
            closingBalance: round2(parseFloat(r.closing_balance) || 0),
        }));
    }

    private async getLedgerHistoryTotals(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        asOfDate: Date,
        mbno: string,
        loantype: string,
    ): Promise<{ totalPrincipalPaid: number; totalInterestCollected: number; totalPayrollLagPrincipal: number }> {
        // Payroll-lag rows stay excluded from installment matching. Closure
        // principal separately nets only post-effective-date lag principal
        // once; older lag principal is already included in the version's
        // opening snapshot. `totalPayrollLagPrincipal` is returned for that
        // explicit reconciliation, not folded into installment payments.
        // Both member and loan type are required because case numbers collide
        // across members and across loan types within a member.
        const rows = await runner.query(
            `SELECT COALESCE(SUM(principal_amount) FILTER (WHERE is_payroll_lag_credit = false), 0) as principal_paid,
                          COALESCE(SUM(interest_amount) FILTER (WHERE is_payroll_lag_credit = false), 0) as interest_paid,
                          COALESCE(SUM(principal_amount) FILTER (WHERE is_payroll_lag_credit = true), 0) as payroll_lag_principal
                   FROM loan_repayment_ledger
                   WHERE loancaseno = $1 AND mbno = $2 AND loantype = $3 AND payment_date <= $4`,
            [loancaseno, mbno, loantype, asOfDate]
        );
        return {
            totalPrincipalPaid: Math.round((parseFloat(rows[0]?.principal_paid) || 0) * 100) / 100,
            totalInterestCollected: Math.round((parseFloat(rows[0]?.interest_paid) || 0) * 100) / 100,
            totalPayrollLagPrincipal: Math.round((parseFloat(rows[0]?.payroll_lag_principal) || 0) * 100) / 100,
        };
    }

    /**
     * Compatibility seam retained for existing UI consumers. Payroll-lag
     * credits are no longer offered as manual adjustments: eligible principal
     * offsets are automatically netted in the closure principal calculation.
     */
    private async getAutoPayrollLagCredit(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        asOfDate: Date,
        mbno?: string,
    ): Promise<number> {
        // The predecessor payment is already classified out of successor-loan
        // principal in getLedgerHistoryTotals(). It is not an additional
        // closure credit/adjustment, so keep this compatibility seam at zero.
        return 0;
    }

    /**
     * Sums the TRUE reducing-balance interest (loan_rb_schedule.rb_interest):
     * once restricted to installments 1..k (the ones whose due month has
     * started by the closure point — "RBInterestTillClosure" in the spec),
     * and once across the whole original schedule (used to back out the
     * compulsory Slot 1/2 interest, since that was spread evenly into
     * instal_amt at disbursement and never stored as its own line item —
     * delayInterest = instal_amt*n − loan_amt − totalRBInterestFullSchedule
     * is algebraically exact, no re-derivation from application date needed).
     *
     * Loans disbursed before loan_rb_schedule existed have no rows here —
     * hasRbSchedule tells the caller to fall back to the old flat-interest
     * method instead, since there's no true RB data to reconcile against.
     */
    private async getRbScheduleTotals(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        uptoInstallmentNo: number,
    ): Promise<{ rbInterestTillClosure: number; totalRBInterestFullSchedule: number; hasRbSchedule: boolean }> {
        const rows = await runner.query(
            `SELECT installment_no, rb_interest FROM loan_rb_schedule WHERE loancaseno::text = $1`,
            [loancaseno]
        );
        if (rows.length === 0) {
            return { rbInterestTillClosure: 0, totalRBInterestFullSchedule: 0, hasRbSchedule: false };
        }
        let rbInterestTillClosure = 0;
        let totalRBInterestFullSchedule = 0;
        for (const r of rows) {
            const v = parseFloat(r.rb_interest) || 0;
            totalRBInterestFullSchedule += v;
            if (r.installment_no <= uptoInstallmentNo) rbInterestTillClosure += v;
        }
        return {
            rbInterestTillClosure: Math.round(rbInterestTillClosure * 100) / 100,
            totalRBInterestFullSchedule: Math.round(totalRBInterestFullSchedule * 100) / 100,
            hasRbSchedule: true,
        };
    }

    /**
     * Method B — the society's manual/legacy average-principal (AP) closure
     * worksheet. This is now the app's ONLY closure-interest method (2026-09
     * decision — replaces the former RB-schedule reconciliation, "Method A":
     * compulsorySlotInterest + rbAdjustment against loan_rb_schedule). Full
     * formulas for both methods, including why they used to agree on a
     * conforming loan and diverge on a restructured one, are kept in
     * docs/loan-closure-methods.md so Method A can be restored later without
     * re-deriving it from scratch — this function is the only place that
     * would need to change back.
     *
     * NR (not-yet-recovered) interest is the flat interest actually billed
     * on every installment whose due month has already started but is still
     * unpaid — interestDue, straight from getInstallmentStatus, exactly as
     * it always has been. The remaining genuinely future installments
     * (noOfInstal − k of them, k = installments already due) are settled by
     * averaging the reducing-balance interest across their remaining
     * principal run, rather than summing loan_rb_schedule row by row:
     *
     *   futurePrincipal   = outstandingPrincipal − NRprincipal
     *   firstOpening      = futurePrincipal
     *   AP endpoint       = standard monthly principal EMI
     *   averagePrincipal  = (firstOpening + AP endpoint) / 2
     *   averageRbInterest = averagePrincipal × monthlyRate
     *   apInterest        = (monthlyInterestForEMI − averageRbInterest) × futureCount
     *
     *   closureInterest   = NRinterest + apInterest
     *
     * futureCount = 0 (every installment already due) collapses apInterest
     * to 0, so closureInterest reduces to plain NRinterest on its own —
     * no separate branch needed. Unlike Method A this never reads
     * loan_rb_schedule, so it needs nothing special for a loan that was
     * disbursed before that table existed either.
     */
    private computeApClosureInterest(
        loanAmt: number,
        noOfInstal: number,
        instalAmt: number,
        annualRate: number,
        outstandingPrincipal: number,
        k: number,
        unpaid: InstallmentStatus[],
        rounding: LoanRoundingMode,
        observedPrincipalEmi?: number,
    ): {
        nrPrincipal: number; nrInterest: number;
        futureInstallmentCount: number; averageRemainingPrincipal: number; averageRbInterest: number;
        apInterest: number; closureInterest: number;
    } {
        const monthlyPrincipal = observedPrincipalEmi && observedPrincipalEmi > 0
            ? observedPrincipalEmi
            : (noOfInstal > 0 ? loanAmt / noOfInstal : 0);
        const totalInterestForEMI = instalAmt * noOfInstal - loanAmt;
        const monthlyInterestForEMI = observedPrincipalEmi && observedPrincipalEmi > 0
            ? Math.max(0, instalAmt - observedPrincipalEmi)
            : (noOfInstal > 0 ? totalInterestForEMI / noOfInstal : 0);
        const monthlyRate = annualRate / 1200;

        const nrPrincipal = round2(unpaid.reduce((sum, i) => sum + i.principalDue, 0));
        const nrInterest = round2(unpaid.reduce((sum, i) => sum + i.interestDue, 0));

        const futureInstallmentCount = Math.max(0, noOfInstal - k);
        let averageRemainingPrincipal = 0;
        let averageRbInterest = 0;
        let apInterest = 0;
        if (monthlyInterestForEMI > 0 && futureInstallmentCount > 0 && monthlyPrincipal > 0) {
            const futurePrincipal = outstandingPrincipal - nrPrincipal;
            const firstOpening = futurePrincipal;
            // Use the stable principal EMI as the AP endpoint, not a small
            // residual final installment distorted by predecessor payroll
            // adjustments during consolidation.
            averageRemainingPrincipal = round2((firstOpening + monthlyPrincipal) / 2);
            averageRbInterest = round2(averageRemainingPrincipal * monthlyRate);
            apInterest = applyLoanRounding((monthlyInterestForEMI - averageRbInterest) * futureInstallmentCount, rounding);
        }

        const closureInterest = applyLoanRounding(nrInterest + apInterest, rounding);
        return { nrPrincipal, nrInterest, futureInstallmentCount, averageRemainingPrincipal, averageRbInterest, apInterest, closureInterest };
    }

    /**
     * Early closure quote for a loan, per the user's explicit reconciliation
     * spec (must move in lockstep with executeEarlyClosure or the quote and
     * what actually gets posted disagree):
     *
     *   outstandingPrincipal = loan_amt − principal actually paid, read from
     *     loan_repayment_ledger — never derived from remaining EMI amounts
     *     or a cached balance column.
     *   closureInterest = the Method B (AP) formula above — see
     *     computeApClosureInterest's doc comment for the full derivation.
     *   + tiered penal on any installment still unpaid + any manual
     *     adjustment.
     *
     * No AP interest, and no flat EMI interest, from installments after the
     * closure point (k) is ever included beyond what the AP formula itself
     * already accounts for — interest on a month that hasn't started yet is
     * never charged twice. Historical ledger rows are only read here, never
     * rewritten.
     *
     * applyRdShare (default true, per the user's spec) additionally quotes
     * how much of finalClosureAmount can be adjusted from the member's RD
     * and Share Value, each retaining a configured minimum balance, RD drawn
     * down before Share — see LoanEligibilityService.getRdShareClosureAdjustment
     * for the actual rule. false shows the figures as if this were switched
     * off (member pays the full amount), matching the frontend's checkbox.
     */
    async calculateEarlyClosure(
        loancaseno: string,
        closureDate?: Date,
        adjustment: number = 0,
        applyRdShare: boolean = true,
        mbno?: string,
    ): Promise<any> {
        // loancaseno is NOT unique across members in this schema (legacy case
        // numbers collide between unrelated members' loans) — without mbno
        // scoping this can silently fetch and quote a DIFFERENT member's loan
        // that happens to share the same case number. mbno stays optional
        // only so existing internal callers that already know they hold a
        // unique caseno keep working; the controller always supplies it.
        const loanRows = await this.dataSource.query(
            mbno
                ? `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months, loan_payment_model
                   FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`
                : `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months, loan_payment_model
                   FROM loan_master WHERE loancaseno::text = $1`,
            mbno ? [loancaseno, mbno] : [loancaseno]
        );
        if (loanRows.length === 0) {
            throw new BadRequestException(`Loan case ${loancaseno} not found in loan_master${mbno ? ` for member ${mbno}` : ''}`);
        }
        const loan = loanRows[0];
        const asOf = closureDate && !isNaN(closureDate.getTime()) ? closureDate : new Date();

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
            await this.assertLedgerReconciled(queryRunner, loancaseno, loan);
            const scheduleVersion = await this.getCurrentScheduleVersion(queryRunner, loancaseno, loan, asOf);
            const penaltyPolicy = await this.getLoanPenaltyPolicy(queryRunner);
            const installments = await this.getInstallmentStatus(queryRunner, loancaseno, loan, asOf);
            const unpaid = installments.filter(i => !i.isFullyPaid);
            const k = installments.length;

            const loanAmt = scheduleVersion ? parseFloat(String(scheduleVersion.opening_principal)) : (parseFloat(loan.loan_amt) || 0);
            const instalAmt = scheduleVersion ? parseFloat(String(scheduleVersion.monthly_installment)) : (parseFloat(loan.instal_amt) || 0);
            const noOfInstal = scheduleVersion ? parseInt(String(scheduleVersion.installment_count), 10) : (parseInt(loan.no_of_instal, 10) || 0);
            const annualRate = scheduleVersion ? parseFloat(String(scheduleVersion.annual_rate)) : (parseFloat(loan.rate) || 12);

            const { totalPrincipalPaid: lifetimePrincipalPaid } = await this.getLedgerHistoryTotals(queryRunner, loancaseno, asOf, loan.mbno, loan.loantype);
            const totalPrincipalPaid = scheduleVersion
                ? await this.getVersionPrincipalPaid(queryRunner, loancaseno, loan.mbno, loan.loantype, asOf, scheduleVersion)
                : lifetimePrincipalPaid;
            const payrollLagPrincipalOffset = await this.getPayrollLagPrincipalOffset(
                queryRunner, loancaseno, loan, asOf, scheduleVersion,
            );

            // Every reported line is rounded to a whole rupee (half-up by
            // default), and finalClosureAmount is the SUM OF THOSE ROUNDED
            // LINES — never a separately-rounded total — so the breakdown an
            // operator reads always adds up to the amount they collect, the
            // same way the society's manual worksheet does.
            const rounding = await this.getRoundingMode(queryRunner);
            const outstandingPrincipal = applyLoanRounding(
                loanAmt - totalPrincipalPaid - payrollLagPrincipalOffset, rounding,
            );
            const penalInterest = applyLoanRounding(unpaid.reduce((sum, i) => sum + i.penalDue, 0), rounding);

            // In separate-interest mode, the remaining principal determines
            // the legacy projection of the remaining principal slots. This
            // keeps the closure quote aligned with the migrated loan's
            // observed principal EMI even when the first/last principal slice
            // contains rounding or consolidation residue.
            const monthlyPrincipal = scheduleVersion
                ? parseFloat(String(scheduleVersion.monthly_principal))
                : (noOfInstal > 0 ? loanAmt / noOfInstal : 0);
            // `k` is the number of schedule months that have actually started
            // as of the closure date. It is the boundary between NR (due-month)
            // installments and genuinely future installments. Deriving this
            // from outstanding principal loses that boundary when the last due
            // installment is only partly paid — exactly the Slot 1 September
            // case where September is NR and the remaining four installments
            // are future/AP installments.
            const closureK = monthlyPrincipal > 0 ? k : 0;

            const observedPrincipalRows = scheduleVersion ? [] : await queryRunner.query(
                `SELECT principal_amount, COUNT(*)::int AS frequency
                 FROM loan_repayment_ledger
                 WHERE loancaseno = $1 AND mbno = $2
                   AND payment_date <= $3 AND is_payroll_lag_credit = false
                   AND principal_amount > 0
                 GROUP BY principal_amount
                 ORDER BY frequency DESC, principal_amount DESC LIMIT 1`,
                [loancaseno, loan.mbno, asOf],
            );
            const observedPrincipalEmi = scheduleVersion
                ? parseFloat(String(scheduleVersion.monthly_principal))
                : parseFloat(observedPrincipalRows[0]?.principal_amount);

            const {
                nrPrincipal, nrInterest, futureInstallmentCount, averageRemainingPrincipal,
                averageRbInterest, apInterest, closureInterest,
            } = this.computeApClosureInterest(
                loanAmt, noOfInstal, instalAmt, annualRate, outstandingPrincipal, closureK, unpaid, rounding,
                loan.loan_payment_model === 'SEPARATE_INTEREST' && Number.isFinite(observedPrincipalEmi)
                    ? observedPrincipalEmi : undefined,
            );

            // The post-effective-date payroll-lag principal was deducted from
            // closure principal above. It is not a manual adjustment and is
            // never counted as an installment payment.
            const suggestedAdjustment = -(await this.getAutoPayrollLagCredit(queryRunner, loancaseno, asOf, loan.mbno));
            const finalClosureAmount = applyLoanRounding(
                outstandingPrincipal + closureInterest + penalInterest + adjustment, rounding,
            );

            const rdShareAdjustment = applyRdShare
                ? await this.loanEligibility.getRdShareClosureAdjustment(loan.mbno, finalClosureAmount)
                : null;
            const payableByMember = rdShareAdjustment ? rdShareAdjustment.payableByMember : finalClosureAmount;

            // Full history so an operator never has to re-derive or ask for
            // this separately before deciding — see the Transaction Flow
            // Atlas §1b and this session's UI audit (loan_master.
            // consolidated_into_loancaseno already existed but was never
            // surfaced; loan_repayment_ledger/loan_rb_schedule likewise).
            const consolidationHistory = await this.getConsolidationHistory(queryRunner, loancaseno, loan.mbno, loan.loantype);
            const allRepaymentHistory = await this.getRepaymentHistory(queryRunner, loancaseno, loan.mbno, loan.loantype);
            const payrollAdjustments = allRepaymentHistory
                .filter(r => r.isPayrollLagCredit)
                .map(r => ({
                    date: r.date,
                    principal: r.principal,
                    interest: r.interest,
                    total: round2(r.principal + r.interest + r.penal),
                    receiptNo: r.receiptNo,
                    predecessorLoanCaseNo: consolidationHistory.absorbedCases[0]?.loancaseno ?? null,
                    affectsOutstandingBalance: new Date(`${r.date.slice(0, 10)}T00:00:00`)
                        >= new Date(`${String(scheduleVersion?.effective_date ?? loan.payment_date).slice(0, 10)}T00:00:00`),
                    countsTowardCurrentInstallments: false,
                }));
            const rbSchedule = await this.getRbSchedule(queryRunner, loancaseno, loan.mbno, loan.loantype);

            return {
                loanCaseNo: loancaseno,
                closureDate: toLocalDateString(asOf),
                outstandingPrincipal,
                payrollLagPrincipalOffset,
                // Method B (AP) breakdown — see computeApClosureInterest's doc
                // comment. nrPrincipal/nrInterest are the flat amounts still
                // owed on installments already due; the average* fields and
                // apInterest cover the genuinely future installments.
                nrPrincipal,
                nrInterest,
                futureInstallmentCount,
                averageRemainingPrincipal,
                averageRbInterest,
                apInterest,
                closureInterest,
                penalInterest,
                penaltyPolicy: {
                    enabled: penaltyPolicy.enabled,
                    annualRate: penaltyPolicy.annualRate,
                    activationDate: penaltyPolicy.activationDate ? toLocalDateString(penaltyPolicy.activationDate) : null,
                },
                adjustment,
                /** Compatibility field; payroll-lag credits are now applied
                 *  automatically to closure principal above, never manually. */
                suggestedAdjustment,
                finalClosureAmount,
                /** Which rounding rule produced the figures above — shown so a
                 *  closure can be reconciled against the manual worksheet. */
                roundingMode: rounding,
                // RD/Share adjustment toward closure (Modify Business Rules
                // spec: ₹1,000 minimum retained in each, RD before Share).
                // null when applyRdShare is false (member pays the full
                // finalClosureAmount, exactly as before this feature existed).
                applyRdShare,
                rdShareAdjustment,
                payableByMember,
                // Raw ingredients behind the figures above — exposed purely so
                // the frontend can show its work (e.g. "Outstanding Principal
                // = Loan Amount − Principal Paid") instead of just the
                // computed totals.
                loanAmt,
                originationLoanAmt: parseFloat(loan.loan_amt) || 0,
                effectiveSchedule: scheduleVersion ? {
                    versionNo: Number(scheduleVersion.version_no),
                    source: scheduleVersion.source,
                    effectiveDate: toLocalDateString(new Date(scheduleVersion.effective_date)),
                    firstDueMonth: toLocalDateString(this.firstDueMonthStart(scheduleVersion)),
                    openingPrincipal: round2(parseFloat(String(scheduleVersion.opening_principal)) || 0),
                    monthlyPrincipal: round2(parseFloat(String(scheduleVersion.monthly_principal)) || 0),
                    installmentCount: Number(scheduleVersion.installment_count),
                    delayMonths: Number(scheduleVersion.delay_months),
                } : null,
                instalAmt,
                noOfInstal,
                totalPrincipalPaid,
                // For display context only — how far into its term this loan
                // is. totalInstallments is the full contracted term;
                // paidInstallments counts only installments already due (k)
                // that are fully settled — future (not-yet-due) installments
                // are neither "paid" nor part of k.
                totalInstallments: noOfInstal,
                paidInstallments: k - unpaid.length,
                unpaidInstallments: unpaid.map(i => ({
                    installmentNo: i.installmentNo,
                    dueDate: toLocalDateString(i.dueDate),
                    principalDue: i.principalDue,
                    interestDue: i.interestDue, // flat, informational — what regular billing would have charged
                    penalDue: i.penalDue,
                    monthsOverdue: i.monthsOverdue,
                    tier: i.tier,
                })),
                // Full history — no re-calculation or separate lookup needed
                // to see what this loan absorbed, what it was paid with, or
                // its amortization schedule.
                consolidationHistory,
                payrollAdjustments,
                // Predecessor payroll is disclosed in payrollAdjustments, not
                // presented as a repayment row on this successor loan.
                repaymentHistory: allRepaymentHistory.filter(r => !r.isPayrollLagCredit),
                rbSchedule,
            };
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Executes an early closure — unlike calculateEarlyClosure (a read-only
     * quote), this actually settles the loan, using the identical
     * outstandingPrincipal/closureInterest reconciliation rule (see that
     * function's doc comment) so the quote and what actually gets posted
     * never disagree. Paying the quoted amount through the regular
     * recordLoanRepayment() waterfall does NOT fully close a loan out: that
     * waterfall only reconciles installments already due, so any genuinely
     * future (not-yet-started-month) installments' principal gets dumped as
     * an undifferentiated "prepayment" with no per-installment ledger entry —
     * loan_master.balance reaches zero, but due-status/EMI-schedule still
     * show those future installments as unpaid. This writes a proper ledger
     * entry for every remaining installment, due or not — future ones
     * principal-only, since interest on a month that hasn't started is never
     * charged — plus a single lump interest-reconciliation entry (the
     * compulsory Slot 1/2 interest plus the RB-vs-flat true-up, which isn't
     * attributable to any one installment) and any manual adjustment, before
     * zeroing the balance.
     */
    async executeEarlyClosure(
        loancaseno: string,
        closureDate?: Date,
        adjustment: number = 0,
        postedBy: string = 'system',
        receiptNo?: string,
        applyRdShare: boolean = true,
        mbno?: string,
    ): Promise<{
        success: boolean;
        message: string;
        finalClosureAmount: number;
        fromRd: number;
        fromShare: number;
        payableByMember: number;
    }> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // See calculateEarlyClosure's matching comment — loancaseno alone
            // is not unique across members here, so this must be mbno-scoped
            // to avoid ever settling a different member's loan that shares
            // the same legacy case number.
            const loanRows = await queryRunner.query(
                mbno
                    ? `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months, loan_payment_model
                       FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`
                    : `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months, loan_payment_model
                       FROM loan_master WHERE loancaseno::text = $1`,
                mbno ? [loancaseno, mbno] : [loancaseno]
            );
            if (loanRows.length === 0) {
                throw new BadRequestException(`Loan case ${loancaseno} not found in loan_master${mbno ? ` for member ${mbno}` : ''}`);
            }
            const loan = loanRows[0];
            const asOf = closureDate && !isNaN(closureDate.getTime()) ? closureDate : new Date();
            const currentBalance = parseFloat(loan.balance) || 0;
            if (currentBalance <= 0) {
                throw new BadRequestException(`Loan ${loancaseno} is already fully repaid`);
            }

            await this.assertLedgerReconciled(queryRunner, loancaseno, loan);

            const scheduleVersion = await this.getCurrentScheduleVersion(queryRunner, loancaseno, loan, asOf);
            const noOfInstal = scheduleVersion ? parseInt(String(scheduleVersion.installment_count), 10) : (parseInt(loan.no_of_instal, 10) || 0);
            const loanAmt = scheduleVersion ? parseFloat(String(scheduleVersion.opening_principal)) : (parseFloat(loan.loan_amt) || 0);
            const instalAmt = scheduleVersion ? parseFloat(String(scheduleVersion.monthly_installment)) : (parseFloat(loan.instal_amt) || 0);
            const annualRate = scheduleVersion ? parseFloat(String(scheduleVersion.annual_rate)) : (parseFloat(loan.rate) || 12);

            // Single shared pooling logic (see getInstallmentStatus's doc
            // comment) — no separate month-bucketed implementation anymore,
            // so this can never disagree with the quote calculateEarlyClosure
            // just showed the operator. includeFuture=true keeps this
            // covering every remaining installment, not just the due ones.
            const installments = await this.getInstallmentStatus(queryRunner, loancaseno, loan, asOf, true);
            const k = installments.filter(i => i.isDue).length;
            const unpaidDue = installments.filter(i => i.isDue && !i.isFullyPaid);

            // Read historical ledger totals BEFORE this closure's own ledger
            // inserts happen below, or they'd double-count against themselves.
            const { totalPrincipalPaid: lifetimePrincipalPaid } = await this.getLedgerHistoryTotals(queryRunner, loancaseno, asOf, loan.mbno, loan.loantype);
            const totalPrincipalPaid = scheduleVersion
                ? await this.getVersionPrincipalPaid(queryRunner, loancaseno, loan.mbno, loan.loantype, asOf, scheduleVersion)
                : lifetimePrincipalPaid;
            const payrollLagPrincipalOffset = await this.getPayrollLagPrincipalOffset(
                queryRunner, loancaseno, loan, asOf, scheduleVersion,
            );

            // Identical rounding to the quote (see calculateEarlyClosure) —
            // both read the same RULE_LOAN_ROUNDING_MODE, so the figure an
            // operator was shown is the figure that gets posted.
            const rounding = await this.getRoundingMode(queryRunner);
            const outstandingPrincipal = applyLoanRounding(
                loanAmt - totalPrincipalPaid - payrollLagPrincipalOffset, rounding,
            );
            const monthlyPrincipal = scheduleVersion
                ? parseFloat(String(scheduleVersion.monthly_principal))
                : (noOfInstal > 0 ? loanAmt / noOfInstal : 0);
            // Keep execution's NR/future boundary identical to the quote;
            // deriving it from balance alone mishandles a partial current EMI.
            const closureK = k;

            // Method B (AP) closure interest — see calculateEarlyClosure /
            // computeApClosureInterest's doc comment for the full formula.
            // apInterest (the genuinely-future-installments component) isn't
            // attributable to any one installment, so it's posted as a single
            // lump row below; nrInterest (already-due installments) is posted
            // naturally per-installment in the loop, same as it always was.
            const { apInterest, futureInstallmentCount, closureInterest } = this.computeApClosureInterest(
                loanAmt, noOfInstal, instalAmt, annualRate, outstandingPrincipal, closureK, unpaidDue, rounding,
                scheduleVersion ? monthlyPrincipal : undefined,
            );

            // Preserve the predecessor lag's no-installment-count rule. At
            // actual settlement, apply its principal offset to the final
            // future principal slice (then earlier future slices if needed),
            // so posted principal rows reconcile to the net closure principal.
            let payrollOffsetRemaining = payrollLagPrincipalOffset;
            for (const inst of [...installments].reverse()) {
                if (inst.isDue || inst.principalDue <= 0 || payrollOffsetRemaining <= 0) continue;
                const applied = Math.min(inst.principalDue, payrollOffsetRemaining);
                inst.principalDue = round2(inst.principalDue - applied);
                payrollOffsetRemaining = round2(payrollOffsetRemaining - applied);
            }
            if (payrollOffsetRemaining > 0.01) {
                throw new BadRequestException(
                    `Payroll-lag principal offset ₹${payrollLagPrincipalOffset.toFixed(2)} exceeds the remaining future principal schedule; closure was stopped for review.`,
                );
            }

            let rawPenalInterest = 0;
            let rawInterestPosted = 0;
            // What the per-installment rows below actually carry, at their own
            // natural precision. The reported totals are rounded to whole
            // rupees, so this is what the rounding-adjustment row at the end
            // reconciles against — without it the posted rows would no longer
            // sum to finalClosureAmount.
            let rawPrincipalPosted = 0;

            for (const inst of installments) {
                if (inst.isFullyPaid || (!inst.isDue && inst.principalDue <= 0)) continue;

                // Already-due installments carry their own flat interest, as
                // always. A genuinely future (not-yet-due) installment's
                // interest is covered entirely by the single AP lump row
                // below instead — it isn't attributable to any one
                // installment — so its row here is principal (and penal,
                // always 0 for a future row) only. inst.interestDue and
                // inst.penalDue are already 0 for a future installment, per
                // getInstallmentStatus.
                const interestForRow = inst.isDue ? inst.interestDue : 0;
                rawInterestPosted += interestForRow;
                rawPenalInterest += inst.penalDue;
                rawPrincipalPosted += inst.principalDue;

                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue,
                         receipt_no, narration, posted_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                    [
                        loan.mbno, loancaseno, loan.loantype, asOf,
                        inst.dueDate.getMonth() + 1, inst.dueDate.getFullYear(),
                        Math.round((inst.principalDue + interestForRow + inst.penalDue) * 100) / 100,
                        inst.principalDue, interestForRow, inst.penalDue, inst.monthsOverdue,
                        receiptNo || null,
                        inst.isDue ? `Early Closure - Installment #${inst.installmentNo}` : `Early Closure - Future Installment #${inst.installmentNo} (principal only)`,
                        postedBy,
                    ]
                );
            }

            if (futureInstallmentCount > 0 && apInterest !== 0) {
                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,0,0,$8,$9,$10)`,
                    [
                        loan.mbno, loancaseno, loan.loantype, asOf, asOf.getMonth() + 1, asOf.getFullYear(),
                        apInterest, receiptNo || null,
                        `Early Closure - AP Closure Interest (average-principal method, ${futureInstallmentCount} future installment(s))`,
                        postedBy,
                    ]
                );
            }

            // No separate day-prorated "stub" interest charge — interest is
            // never day-prorated in this system.
            if (adjustment !== 0) {
                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,0,0,$8,'Early Closure - Applicable Adjustment',$9)`,
                    [loan.mbno, loancaseno, loan.loantype, asOf, asOf.getMonth() + 1, asOf.getFullYear(), adjustment, receiptNo || null, postedBy]
                );
            }

            // mbno-scoped — the single most important place this matters:
            // without it, closing a loan whose case number collides with
            // another member's could zero out the WRONG member's balance.
            // ALSO loantype-scoped — loancaseno collides within a single
            // member too (see the matching comment on recordLoanRepayment's
            // balance UPDATE above); a bare zero-out here would wrongly zero
            // a same-numbered sibling case's balance as well.
            await queryRunner.query(
                `UPDATE loan_master SET balance = 0 WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3`,
                [loancaseno, loan.mbno, loan.loantype]
            );

            // BUG FIX 39 (same defect as pass-transaction.service.ts BUG FIX 37, found separately
            // here since this service never shared that fix): tested only 'ELN', but ALN is the
            // loan type every real loan in this system uses. Confirmed live on real test data —
            // after a ₹2,132 repayment on an ALN loan, member_balances.emergency_loan_balance was
            // still the full disbursed amount (regularloan was decremented instead, floored at 0
            // by GREATEST since it started there) while loan_master.balance had correctly dropped.
            // A member who fully repays an ALN loan would show its full original amount against
            // their emergency-loan eligibility forever, since nothing ever brings it back down.
            const isEmergency = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes((loan.loantype || '').toUpperCase())
                || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
            if (isEmergency) {
                await queryRunner.query(
                    `UPDATE member_balances SET emergency_loan_balance = GREATEST(0, COALESCE(emergency_loan_balance, 0) - $1) WHERE mbno = $2`,
                    [outstandingPrincipal, loan.mbno]
                );
            } else {
                await queryRunner.query(
                    `UPDATE member_balances SET regularloan = GREATEST(0, COALESCE(regularloan, 0) - $1) WHERE mbno = $2`,
                    [outstandingPrincipal, loan.mbno]
                );
            }

            const penalInterest = applyLoanRounding(rawPenalInterest, rounding);
            // The net outstanding principal and future principal rows already
            // include the post-consolidation payroll-lag offset, matching the
            // read-only quote exactly.
            const finalClosureAmount = applyLoanRounding(
                outstandingPrincipal + closureInterest + penalInterest + adjustment, rounding,
            );

            // The per-installment rows above were posted at their own natural
            // precision, while every reported figure is rounded to a whole
            // rupee — so without this the ledger would no longer sum to the
            // amount actually collected. One explicit row carries that
            // difference instead of leaving it as an unexplained gap.
            const postedSoFar = rawPrincipalPosted + rawInterestPosted + rawPenalInterest
                + (futureInstallmentCount > 0 ? apInterest : 0) + adjustment;
            const roundingDelta = Math.round((finalClosureAmount - postedSoFar) * 100) / 100;
            if (roundingDelta !== 0) {
                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,0,0,$8,$9,$10)`,
                    [
                        loan.mbno, loancaseno, loan.loantype, asOf, asOf.getMonth() + 1, asOf.getFullYear(),
                        roundingDelta, receiptNo || null,
                        `Early Closure - Rounding Adjustment (${rounding})`,
                        postedBy,
                    ]
                );
            }

            // RD/Share adjustment toward closure — re-derived fresh here
            // rather than trusting whatever the operator's earlier quote
            // said, same principle as outstandingPrincipal/closureInterest
            // above. RD is withdrawn via the real RD service (so it goes
            // through the same closed-year guard, minimum-balance check and
            // FIFO installment draw-down as any other RD withdrawal); Share
            // is debited directly since this app has no dedicated Share
            // ledger of its own to post through. Neither posts to
            // loan_repayment_ledger — the principal/interest/penal/
            // adjustment rows above already sum to finalClosureAmount
            // regardless of payment source; this only records WHERE that
            // money came from, on the RD/Share side.
            let fromRd = 0;
            let fromShare = 0;
            if (applyRdShare) {
                const rdShareAdjustment = await this.loanEligibility.getRdShareClosureAdjustment(loan.mbno, finalClosureAmount);
                fromRd = rdShareAdjustment.fromRd;
                fromShare = rdShareAdjustment.fromShare;

                if (fromRd > 0 && rdShareAdjustment.yearcode) {
                    await this.rdBalanceEvents.recordWithdrawal(
                        loan.mbno, rdShareAdjustment.yearcode, fromRd, asOf, postedBy,
                        `Applied to loan ${loancaseno} early closure`, queryRunner,
                    );
                }
                if (fromShare > 0) {
                    const shareUpdateResult = await queryRunner.query(
                        `UPDATE member_balances SET shares = shares - $1
                         WHERE mbno = $2 AND shares - $1 >= $3
                         RETURNING shares`,
                        [fromShare, loan.mbno, rdShareAdjustment.shareMinBalance],
                    );
                    // queryRunner.query() for a non-SELECT returns
                    // [rows[], rowCount] -- shareUpdateResult[0] is the
                    // actual RETURNING rows, never shareUpdateResult itself.
                    const shareRows = shareUpdateResult[0];
                    if (shareRows.length === 0) {
                        // Shouldn't happen given the fresh read above, unless
                        // a concurrent change raced us — fail safe rather
                        // than silently debit less than computed.
                        throw new BadRequestException(
                            `Share Value changed concurrently and no longer supports a ₹${fromShare.toLocaleString('en-IN')} adjustment. Please retry.`,
                        );
                    }
                }
            }
            const payableByMember = Math.round((finalClosureAmount - fromRd - fromShare) * 100) / 100;

            await queryRunner.commitTransaction();

            const sourceNote = (fromRd > 0 || fromShare > 0)
                ? ` (₹${fromRd.toLocaleString('en-IN')} from RD + ₹${fromShare.toLocaleString('en-IN')} from Share Value applied; ₹${payableByMember.toLocaleString('en-IN')} payable by member)`
                : '';
            return {
                success: true,
                message: `Loan ${loancaseno} closed early as of ${toLocalDateString(asOf)}. Final closure amount: ₹${finalClosureAmount.toLocaleString('en-IN')}${sourceNote}.`,
                finalClosureAmount,
                fromRd,
                fromShare,
                payableByMember,
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * What a loan actually owes right now, oldest-unpaid-first — used by the
     * repayment screen to show the operator what a payment will be applied
     * against (and what it'll cost, including penal) before they submit,
     * instead of a free-text month/year picker the backend no longer honors.
     */
    async getDueStatus(loancaseno: string, asOfDate?: Date): Promise<any> {
        const loanRows = await this.dataSource.query(
            `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months, loan_payment_model
             FROM loan_master WHERE loancaseno::text = $1`,
            [loancaseno]
        );
        if (loanRows.length === 0) {
            throw new BadRequestException(`Loan case ${loancaseno} not found in loan_master`);
        }
        const loan = loanRows[0];
        const asOf = asOfDate && !isNaN(asOfDate.getTime()) ? asOfDate : new Date();

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
            const installments = await this.getInstallmentStatus(queryRunner, loancaseno, loan, asOf);
            const unpaid = installments.filter(i => !i.isFullyPaid);

            const totalPrincipalDue = Math.round(unpaid.reduce((sum, i) => sum + i.principalDue, 0) * 100) / 100;
            const totalInterestDue = Math.round(unpaid.reduce((sum, i) => sum + i.interestDue, 0) * 100) / 100;
            const totalPenalDue = Math.round(unpaid.reduce((sum, i) => sum + i.penalDue, 0) * 100) / 100;

            // How the constant EMI itself was built — same derivation as
            // calculateEarlyClosure's "How This Was Calculated" trace, just for
            // the EMI amount rather than a closure amount. Purely informational
            // — doesn't affect any due/penal figures above.
            const scheduleVersion = await this.getCurrentScheduleVersion(queryRunner, loancaseno, loan, asOf);
            const loanAmt = scheduleVersion ? parseFloat(String(scheduleVersion.opening_principal)) : (parseFloat(loan.loan_amt) || 0);
            const instalAmt = scheduleVersion ? parseFloat(String(scheduleVersion.monthly_installment)) : (parseFloat(loan.instal_amt) || 0);
            const noOfInstalNum = scheduleVersion ? parseInt(String(scheduleVersion.installment_count), 10) : (parseInt(loan.no_of_instal, 10) || 0);
            const monthlyPrincipal = scheduleVersion
                ? parseFloat(String(scheduleVersion.monthly_principal))
                : (noOfInstalNum > 0 ? Math.round((loanAmt / noOfInstalNum) * 100) / 100 : 0);
            const monthlyInterestForEMI = scheduleVersion
                ? Math.max(0, Math.round((instalAmt - monthlyPrincipal) * 100) / 100)
                : (noOfInstalNum > 0
                    ? Math.round(((instalAmt * noOfInstalNum - loanAmt) / noOfInstalNum) * 100) / 100
                    : 0);
            const totalInterestForEMI = Math.round(monthlyInterestForEMI * noOfInstalNum * 100) / 100;
            const { totalRBInterestFullSchedule, hasRbSchedule } = await this.getRbScheduleTotals(queryRunner, loancaseno, noOfInstalNum);
            const compulsorySlotInterest = hasRbSchedule ? Math.round((totalInterestForEMI - totalRBInterestFullSchedule) * 100) / 100 : 0;

            return {
                loanCaseNo: loancaseno,
                oldestUnpaidInstallment: unpaid.length > 0 ? unpaid[0].installmentNo : null,
                unpaidInstallments: unpaid.map(i => ({
                    installmentNo: i.installmentNo,
                    dueDate: toLocalDateString(i.dueDate),
                    principalDue: i.principalDue,
                    interestDue: i.interestDue,
                    penalDue: i.penalDue,
                    monthsOverdue: i.monthsOverdue,
                    tier: i.tier,
                })),
                totalPrincipalDue,
                totalInterestDue,
                totalPenalDue,
                totalDue: Math.round((totalPrincipalDue + totalInterestDue + totalPenalDue) * 100) / 100,
                // For display context only — how far into its term this loan is.
                // totalInstallments is the full contracted term; paidInstallments
                // counts only installments already due (k = installments.length,
                // since this call doesn't pass includeFuture) that are fully
                // settled — future not-yet-due installments count toward neither.
                totalInstallments: noOfInstalNum,
                paidInstallments: installments.length - unpaid.length,
                emiBreakdown: {
                    loanAmt,
                    instalAmt,
                    noOfInstal: noOfInstalNum,
                    monthlyPrincipal,
                    monthlyInterestForEMI,
                    totalInterestForEMI,
                    totalRBInterestFullSchedule,
                    compulsorySlotInterest,
                    hasRbSchedule,
                },
            };
        } finally {
            await queryRunner.release();
        }
    }

    async getMemberRepaymentHistory(mbno: string): Promise<any[]> {
        // remaining_balance used to be lm.balance — the loan's CURRENT balance,
        // identical on every historical row for that loan instead of what the
        // balance actually was right after each transaction. This computes a
        // true running balance: original principal minus principal paid so far,
        // ordered by id (the order transactions were actually applied in).
        return this.dataSource.query(
            `SELECT
                lrl.id, lrl.loancaseno, lrl.loantype,
                lrl.payment_date, lrl.payment_month, lrl.payment_year,
                lrl.payment_amount, lrl.principal_amount, lrl.interest_amount, lrl.penal_amount, lrl.months_overdue,
                lrl.receipt_no, lrl.narration,
                lm.loan_amt,
                -- Due date: the loan's configured grace day (due date and grace
                -- period are the same concept in this cooperative's model — see
                -- getInstallmentStatus's matching comment), applied to this row's
                -- for-month/for-year. GREATEST(...,1) guards against an
                -- unconfigured (0) grace value landing on the previous month's
                -- last day (Postgres day-0 semantics). LEAST(...,28) avoids
                -- invalid dates (e.g. "Feb 30") without needing the real days-
                -- in-month for what is just a historical display column.
                make_date(
                    lrl.payment_year, lrl.payment_month,
                    LEAST(GREATEST(COALESCE(lm.gracedays, 1), 1), 28)
                ) as due_date,
                lm.loan_amt - SUM(CASE WHEN lrl.is_payroll_lag_credit THEN 0 ELSE lrl.principal_amount END)
                    OVER (PARTITION BY lrl.mbno, lrl.loancaseno ORDER BY lrl.id) as remaining_balance
             FROM loan_repayment_ledger lrl
             LEFT JOIN loan_master lm ON lm.loancaseno::text = lrl.loancaseno
             WHERE lrl.mbno = $1 AND lrl.is_payroll_lag_credit = false
             ORDER BY lrl.created_at DESC, lrl.id DESC`,
            [mbno]
        );
    }

    async getLoanRepaymentSummary(loancaseno: string): Promise<any> {
        const rows = await this.dataSource.query(
            `SELECT
                lm.loancaseno, lm.loantype,
                lm.loan_amt as sanctioned_amount,
                CASE WHEN schedule.effective_date IS NOT NULL THEN GREATEST(0,
                       schedule.opening_principal::numeric - COALESCE(
                         SUM(lrl.principal_amount) FILTER (
                           WHERE lrl.is_payroll_lag_credit = false
                             AND lrl.payment_date >= schedule.effective_date
                         ), 0
                       ))
                     WHEN COUNT(lrl.id) FILTER (WHERE lrl.is_payroll_lag_credit = true) > 0
                     THEN GREATEST(0, lm.loan_amt - COALESCE(
                       SUM(lrl.principal_amount) FILTER (WHERE lrl.is_payroll_lag_credit = false), 0
                     ))
                     ELSE lm.balance END as current_balance,
                lm.no_of_instal as total_installments,
                lm.instal_amt as emi_amount,
                COALESCE(SUM(lrl.payment_amount) FILTER (WHERE lrl.is_payroll_lag_credit = false), 0) as total_paid,
                COALESCE(SUM(lrl.principal_amount) FILTER (WHERE lrl.is_payroll_lag_credit = false), 0) as total_principal_paid,
                COALESCE(SUM(lrl.interest_amount) FILTER (WHERE lrl.is_payroll_lag_credit = false), 0) as total_interest_paid,
                COALESCE(SUM(lrl.penal_amount) FILTER (WHERE lrl.is_payroll_lag_credit = false), 0) as total_penal_paid,
                COUNT(lrl.id) FILTER (WHERE lrl.is_payroll_lag_credit = false) as payments_made
             FROM loan_master lm
             LEFT JOIN LATERAL (
               SELECT sv.effective_date, sv.opening_principal
               FROM loan_schedule_versions sv
               WHERE sv.mbno = lm.mbno
                 AND sv.loantype = lm.loantype
                 AND sv.loancaseno::text = lm.loancaseno::text
                 AND sv.effective_date <= CURRENT_DATE
               ORDER BY sv.effective_date DESC, sv.version_no DESC
               LIMIT 1
             ) schedule ON TRUE
             LEFT JOIN loan_repayment_ledger lrl
               ON lrl.loancaseno = lm.loancaseno::text AND lrl.mbno = lm.mbno AND lrl.loantype = lm.loantype
             WHERE lm.loancaseno::text = $1
             GROUP BY lm.loancaseno, lm.loantype, lm.loan_amt, lm.balance, lm.no_of_instal, lm.instal_amt,
                      schedule.effective_date, schedule.opening_principal`,
            [loancaseno]
        );
        return rows[0] || null;
    }
}
