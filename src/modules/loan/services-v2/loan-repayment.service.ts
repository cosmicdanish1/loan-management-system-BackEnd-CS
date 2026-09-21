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

@Injectable()
export class LoanRepaymentService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly loanEligibility: LoanEligibilityService,
        private readonly rdBalanceEvents: RdBalanceEventsService,
    ) {}

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
    private async getInstallmentStatus(
        queryRunner: QueryRunner,
        loancaseno: string,
        loan: any,
        asOfDate: Date = new Date(),
        includeFuture: boolean = false,
    ): Promise<InstallmentStatus[]> {
        const loanAmt = parseFloat(loan.loan_amt) || 0;
        const noOfInstal = parseInt(loan.no_of_instal, 10) || 0;
        const instalAmt = parseFloat(loan.instal_amt) || 0;
        const penalRateAnnual = parseFloat(loan.penalrate) || 0;
        const graceDayOfMonth = parseInt(loan.gracedays, 10) || 0;
        const sameMonthPenalPct = parseFloat(loan.smpenalpct) || 0;
        const sameMonthPenalDivisor = parseFloat(loan.smpenaldiv) || 0;
        const disbursementDate = new Date(loan.payment_date);
        // Slot delay months, frozen onto this loan at disbursement (see
        // pass-transaction.service.ts) — NULL on any loan disbursed before
        // this column existed, treated as 0 (no schedule shift), preserving
        // this system's original behavior for those older loans.
        const delayMonths = parseInt(loan.delay_months, 10) || 0;

        if (noOfInstal <= 0 || isNaN(disbursementDate.getTime())) return [];

        const monthlyPrincipal = loanAmt / noOfInstal;
        const totalInterest = Math.max(0, instalAmt * noOfInstal - loanAmt);
        const monthlyInterest = totalInterest / noOfInstal;

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
             WHERE loancaseno = $1 AND mbno = $2 AND payment_date <= $3 AND is_payroll_lag_credit = false`,
            [loancaseno, loan.mbno, asOfDate]
        );
        let principalPool = parseFloat(totalsRow[0]?.principal_paid) || 0;
        let interestPool = parseFloat(totalsRow[0]?.interest_paid) || 0;

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
             WHERE loancaseno = $1 AND mbno = $2 AND payment_date <= $3 AND penal_amount > 0`,
            [loancaseno, loan.mbno, asOfDate],
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
        let pool = principalPool + interestPool;

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
            // and lastOpening (from futureInstallmentCount) stop describing
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
            const isPrepaidAhead = !isDue && pool >= instalAmt - prepaidTolerance;

            if (!isDue && !isPrepaidAhead && !includeFuture) break; // due month hasn't started yet, and nothing prepaid to cover it

            // Spend the fungible pool against this installment's full
            // instalAmt as one unit — principal share first (this loan's
            // normal recovery convention), whatever's left toward interest.
            // isSettled/isPrepaidAhead already establish "close enough" via
            // the tolerances above, so the tiny sub-tolerance residue left
            // by rounding is swept to 0 rather than misreading a genuinely
            // settled installment as unpaid.
            const totalApplied = Math.min(instalAmt, pool);
            pool -= totalApplied;
            const principalApplied = Math.min(monthlyPrincipal, totalApplied);
            const paid = { principal: Math.round(principalApplied * 100) / 100, interest: 0 };
            const principalDue = isSettled || isPrepaidAhead
                ? 0
                : Math.max(0, Math.round((monthlyPrincipal - principalApplied) * 100) / 100);

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
                const interestApplied = totalApplied - principalApplied;
                paid.interest = Math.round(interestApplied * 100) / 100;
                interestDue = isSettled || isPrepaidAhead
                    ? 0
                    : Math.max(0, Math.round((monthlyInterest - interestApplied) * 100) / 100);
            }

            const isFullyPaid = principalDue <= 0 && interestDue <= 0;

            if (isDue) {
                const tierResult = computeTier(
                    principalDue, isFullyPaid, dueDate, asOfDate,
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
                monthlyPrincipal: Math.round(monthlyPrincipal * 100) / 100,
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
                        payment_date, delay_months, payroll_lag_watch_until, payroll_lag_old_principal, payroll_lag_old_interest
                 FROM loan_master WHERE ${whereParts.join(' AND ')}`,
                params
            );
            if (loanRows.length === 0) {
                throw new BadRequestException(`Loan case ${dto.loancaseno} not found in loan_master${dto.mbno ? ` for member ${dto.mbno}` : ''}`);
            }
            const loan = loanRows[0];
            const currentBalance = parseFloat(loan.balance || 0);
            const payment = parseFloat(dto.paymentAmount as any);

            if (payment <= 0) throw new BadRequestException('Payment amount must be greater than zero');
            if (currentBalance <= 0) throw new BadRequestException(`Loan ${dto.loancaseno} is already fully repaid`);

            const asOf = dto.asOfDate && !isNaN(dto.asOfDate.getTime()) ? dto.asOfDate : new Date();

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
                        `SELECT 1 FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND mbno = $2 AND is_payroll_lag_credit = true LIMIT 1`,
                        [dto.loancaseno, dto.mbno]
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
                                + `excluded from this loan's schedule and netted from the closure amount instead`,
                                dto.username || 'system',
                            ]
                        );
                        await queryRunner.commitTransaction();
                        return {
                            success: true,
                            message: `Recognized as the old loan's payroll-lag EMI (₹${oldPrincipal.toLocaleString('en-IN')} `
                                + `principal + ₹${oldInterest.toLocaleString('en-IN')} interest) — recorded as an automatic `
                                + `credit, not applied against this loan's own installments.`,
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
    private async getLedgerHistoryTotals(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        asOfDate: Date,
        mbno?: string,
    ): Promise<{ totalPrincipalPaid: number; totalInterestCollected: number }> {
        // is_payroll_lag_credit excluded — see getInstallmentStatus's matching
        // comment and AddPayrollLagCredit1758900000000. That money is real,
        // but not against THIS loan's schedule; getAutoPayrollLagCredit below
        // is what nets it back into the closure amount.
        // mbno-scoped alongside loancaseno for the same reason as
        // getInstallmentStatus's matching queries — loancaseno collides
        // across members in this schema. Optional only so any caller that
        // hasn't been updated yet keeps its old (ambiguous) behavior rather
        // than breaking outright.
        const rows = await runner.query(
            mbno
                ? `SELECT COALESCE(SUM(principal_amount), 0) as principal_paid,
                          COALESCE(SUM(interest_amount), 0) as interest_paid
                   FROM loan_repayment_ledger
                   WHERE loancaseno = $1 AND mbno = $2 AND payment_date <= $3 AND is_payroll_lag_credit = false`
                : `SELECT COALESCE(SUM(principal_amount), 0) as principal_paid,
                          COALESCE(SUM(interest_amount), 0) as interest_paid
                   FROM loan_repayment_ledger
                   WHERE loancaseno = $1 AND payment_date <= $2 AND is_payroll_lag_credit = false`,
            mbno ? [loancaseno, mbno, asOfDate] : [loancaseno, asOfDate]
        );
        return {
            totalPrincipalPaid: Math.round((parseFloat(rows[0]?.principal_paid) || 0) * 100) / 100,
            totalInterestCollected: Math.round((parseFloat(rows[0]?.interest_paid) || 0) * 100) / 100,
        };
    }

    /**
     * Sums every payroll-lag credit row recorded against this loan (see
     * AddPayrollLagCredit1758900000000 and recordLoanRepayment's detection
     * logic) — real money the member already paid via BSP payroll, on the
     * predecessor loan this case consolidated, excluded from this loan's own
     * schedule/totals above. Returned as a positive rupee amount; the caller
     * nets it OUT of the closure amount (it reduces what's still owed).
     * Replaces what used to be a manually-typed `adjustment` value.
     */
    private async getAutoPayrollLagCredit(
        runner: DataSource | QueryRunner,
        loancaseno: string,
        asOfDate: Date,
        mbno?: string,
    ): Promise<number> {
        // mbno-scoped for the same reason as getLedgerHistoryTotals — see its
        // comment.
        const rows = await runner.query(
            mbno
                ? `SELECT COALESCE(SUM(principal_amount + interest_amount), 0) as credit
                   FROM loan_repayment_ledger
                   WHERE loancaseno = $1 AND mbno = $2 AND payment_date <= $3 AND is_payroll_lag_credit = true`
                : `SELECT COALESCE(SUM(principal_amount + interest_amount), 0) as credit
                   FROM loan_repayment_ledger
                   WHERE loancaseno = $1 AND payment_date <= $2 AND is_payroll_lag_credit = true`,
            mbno ? [loancaseno, mbno, asOfDate] : [loancaseno, asOfDate]
        );
        return Math.round((parseFloat(rows[0]?.credit) || 0) * 100) / 100;
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
     *   lastOpening       = futurePrincipal − (futureCount − 1) × monthlyPrincipal
     *   averagePrincipal  = (firstOpening + lastOpening) / 2
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
    ): {
        nrPrincipal: number; nrInterest: number;
        futureInstallmentCount: number; averageRemainingPrincipal: number; averageRbInterest: number;
        apInterest: number; closureInterest: number;
    } {
        const monthlyPrincipal = noOfInstal > 0 ? loanAmt / noOfInstal : 0;
        const totalInterestForEMI = instalAmt * noOfInstal - loanAmt;
        const monthlyInterestForEMI = noOfInstal > 0 ? totalInterestForEMI / noOfInstal : 0;
        const monthlyRate = annualRate / 1200;

        const nrPrincipal = round2(unpaid.reduce((sum, i) => sum + i.principalDue, 0));
        const nrInterest = round2(unpaid.reduce((sum, i) => sum + i.interestDue, 0));

        const futureInstallmentCount = Math.max(0, noOfInstal - k);
        let averageRemainingPrincipal = 0;
        let averageRbInterest = 0;
        let apInterest = 0;
        if (futureInstallmentCount > 0 && monthlyPrincipal > 0) {
            const futurePrincipal = outstandingPrincipal - nrPrincipal;
            const firstOpening = futurePrincipal;
            const lastOpening = futurePrincipal - (futureInstallmentCount - 1) * monthlyPrincipal;
            averageRemainingPrincipal = round2((firstOpening + lastOpening) / 2);
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
                ? `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months
                   FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`
                : `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months
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
            const installments = await this.getInstallmentStatus(queryRunner, loancaseno, loan, asOf);
            const unpaid = installments.filter(i => !i.isFullyPaid);
            const k = installments.length;

            const loanAmt = parseFloat(loan.loan_amt) || 0;
            const instalAmt = parseFloat(loan.instal_amt) || 0;
            const noOfInstal = parseInt(loan.no_of_instal, 10) || 0;
            const annualRate = parseFloat(loan.rate) || 12;

            const { totalPrincipalPaid } = await this.getLedgerHistoryTotals(queryRunner, loancaseno, asOf, loan.mbno);

            // Every reported line is rounded to a whole rupee (half-up by
            // default), and finalClosureAmount is the SUM OF THOSE ROUNDED
            // LINES — never a separately-rounded total — so the breakdown an
            // operator reads always adds up to the amount they collect, the
            // same way the society's manual worksheet does.
            const rounding = await this.getRoundingMode(queryRunner);
            const outstandingPrincipal = applyLoanRounding(loanAmt - totalPrincipalPaid, rounding);
            const penalInterest = applyLoanRounding(unpaid.reduce((sum, i) => sum + i.penalDue, 0), rounding);

            const {
                nrPrincipal, nrInterest, futureInstallmentCount, averageRemainingPrincipal,
                averageRbInterest, apInterest, closureInterest,
            } = this.computeApClosureInterest(
                loanAmt, noOfInstal, instalAmt, annualRate, outstandingPrincipal, k, unpaid, rounding,
            );

            // Payroll-lag credit, detected at payment time (see
            // recordLoanRepayment) — per the user's explicit decision, this is
            // SUGGESTED only, never auto-applied. It does NOT enter
            // finalClosureAmount below; it's returned separately so the
            // frontend can show it and pre-fill the manual `adjustment` field,
            // but an operator must actively accept it (hit Recalc) before it
            // affects what the member is charged. Keeps a human checkpoint on
            // every case, including the (rare, but real) risk of a genuine
            // payment coincidentally matching the old EMI amount.
            const suggestedAdjustment = -(await this.getAutoPayrollLagCredit(queryRunner, loancaseno, asOf, loan.mbno));
            const finalClosureAmount = applyLoanRounding(
                outstandingPrincipal + closureInterest + penalInterest + adjustment, rounding,
            );

            const rdShareAdjustment = applyRdShare
                ? await this.loanEligibility.getRdShareClosureAdjustment(loan.mbno, finalClosureAmount)
                : null;
            const payableByMember = rdShareAdjustment ? rdShareAdjustment.payableByMember : finalClosureAmount;

            return {
                loanCaseNo: loancaseno,
                closureDate: toLocalDateString(asOf),
                outstandingPrincipal,
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
                adjustment,
                /** Payroll-lag credit, DETECTED but never auto-applied — see
                 *  getAutoPayrollLagCredit and this function's doc comment.
                 *  Negative (or 0 if none applies). NOT included in
                 *  finalClosureAmount below; the frontend offers it as a
                 *  one-click suggestion for the `adjustment` field, and the
                 *  operator must hit Recalc to actually apply it. */
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
                    ? `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months
                       FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`
                    : `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, rate, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months
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

            const noOfInstal = parseInt(loan.no_of_instal, 10) || 0;
            const loanAmt = parseFloat(loan.loan_amt) || 0;
            const instalAmt = parseFloat(loan.instal_amt) || 0;
            const annualRate = parseFloat(loan.rate) || 12;

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
            const { totalPrincipalPaid } = await this.getLedgerHistoryTotals(queryRunner, loancaseno, asOf, loan.mbno);

            // Identical rounding to the quote (see calculateEarlyClosure) —
            // both read the same RULE_LOAN_ROUNDING_MODE, so the figure an
            // operator was shown is the figure that gets posted.
            const rounding = await this.getRoundingMode(queryRunner);
            const outstandingPrincipal = applyLoanRounding(loanAmt - totalPrincipalPaid, rounding);

            // Method B (AP) closure interest — see calculateEarlyClosure /
            // computeApClosureInterest's doc comment for the full formula.
            // apInterest (the genuinely-future-installments component) isn't
            // attributable to any one installment, so it's posted as a single
            // lump row below; nrInterest (already-due installments) is posted
            // naturally per-installment in the loop, same as it always was.
            const { apInterest, futureInstallmentCount, closureInterest } = this.computeApClosureInterest(
                loanAmt, noOfInstal, instalAmt, annualRate, outstandingPrincipal, k, unpaidDue, rounding,
            );

            let rawPenalInterest = 0;
            let rawInterestPosted = 0;
            // What the per-installment rows below actually carry, at their own
            // natural precision. The reported totals are rounded to whole
            // rupees, so this is what the rounding-adjustment row at the end
            // reconciles against — without it the posted rows would no longer
            // sum to finalClosureAmount.
            let rawPrincipalPosted = 0;

            for (const inst of installments) {
                if (inst.isFullyPaid) continue;

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
            // Payroll-lag credit is NEVER auto-applied here — see
            // calculateEarlyClosure's matching comment. It's only ever a
            // SUGGESTION on the quote screen; an operator who accepts it
            // types/copies it into `adjustment` before calling execute, same
            // as any other manual adjustment. This function stays in lockstep
            // with the quote by using `adjustment` exactly as passed, nothing
            // implicit added — if the operator didn't apply the suggestion,
            // execute doesn't apply it either.
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
            `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date, delay_months
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
            const loanAmt = parseFloat(loan.loan_amt) || 0;
            const instalAmt = parseFloat(loan.instal_amt) || 0;
            const noOfInstalNum = parseInt(loan.no_of_instal, 10) || 0;
            const monthlyPrincipal = noOfInstalNum > 0 ? Math.round((loanAmt / noOfInstalNum) * 100) / 100 : 0;
            const totalInterestForEMI = Math.round((instalAmt * noOfInstalNum - loanAmt) * 100) / 100;
            const monthlyInterestForEMI = noOfInstalNum > 0 ? Math.round((totalInterestForEMI / noOfInstalNum) * 100) / 100 : 0;
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
                lm.loan_amt - SUM(lrl.principal_amount) OVER (PARTITION BY lrl.loancaseno ORDER BY lrl.id) as remaining_balance
             FROM loan_repayment_ledger lrl
             LEFT JOIN loan_master lm ON lm.loancaseno::text = lrl.loancaseno
             WHERE lrl.mbno = $1
             ORDER BY lrl.created_at DESC, lrl.id DESC`,
            [mbno]
        );
    }

    async getLoanRepaymentSummary(loancaseno: string): Promise<any> {
        const rows = await this.dataSource.query(
            `SELECT
                lm.loancaseno, lm.loantype,
                lm.loan_amt as sanctioned_amount,
                lm.balance as current_balance,
                lm.no_of_instal as total_installments,
                lm.instal_amt as emi_amount,
                COALESCE(SUM(lrl.payment_amount), 0) as total_paid,
                COALESCE(SUM(lrl.principal_amount), 0) as total_principal_paid,
                COALESCE(SUM(lrl.interest_amount), 0) as total_interest_paid,
                COALESCE(SUM(lrl.penal_amount), 0) as total_penal_paid,
                COUNT(lrl.id) as payments_made
             FROM loan_master lm
             LEFT JOIN loan_repayment_ledger lrl ON lrl.loancaseno = lm.loancaseno::text
             WHERE lm.loancaseno::text = $1
             GROUP BY lm.loancaseno, lm.loantype, lm.loan_amt, lm.balance, lm.no_of_instal, lm.instal_amt`,
            [loancaseno]
        );
        return rows[0] || null;
    }
}
