import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { LoanEligibilityService } from './loan-eligibility.service';
import { RdBalanceEventsService } from '../../rd/services/rd-balance-events.service';

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
        const totalsRow = await queryRunner.query(
            `SELECT COALESCE(SUM(principal_amount), 0) as principal_paid,
                    COALESCE(SUM(interest_amount), 0) as interest_paid
             FROM loan_repayment_ledger
             WHERE loancaseno = $1 AND payment_date <= $2`,
            [loancaseno, asOfDate]
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
             WHERE loancaseno = $1 AND payment_date <= $2 AND penal_amount > 0`,
            [loancaseno, asOfDate],
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

        const asOfYear = asOfDate.getFullYear();
        const asOfMonth0 = asOfDate.getMonth();
        const result: InstallmentStatus[] = [];

        for (let n = 1; n <= noOfInstal; n++) {
            const dueDate = new Date(disbursementDate);
            dueDate.setMonth(dueDate.getMonth() + n);
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
            if (!isDue && !includeFuture) break; // due month hasn't started yet

            const principalApplied = Math.min(monthlyPrincipal, principalPool);
            principalPool -= principalApplied;
            const paid = { principal: Math.round(principalApplied * 100) / 100, interest: 0 };
            const principalDue = isSettled
                ? 0
                : Math.max(0, Math.round((monthlyPrincipal - principalApplied) * 100) / 100);

            // Interest and penal are never charged on a month that hasn't
            // started yet — a future installment can only ever be
            // principal-prepaid, so its interest pool is left untouched and
            // computeTier is never called for it (asOfDate necessarily
            // precedes its due month, so a tier comparison would be
            // meaningless).
            let interestDue = 0;
            let tier: PenalTier = 0;
            let monthsOverdue = 0;
            let penalDue = 0;
            if (isDue) {
                const interestApplied = Math.min(monthlyInterest, interestPool);
                interestPool -= interestApplied;
                paid.interest = Math.round(interestApplied * 100) / 100;
                interestDue = isSettled
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
            const loanRows = await queryRunner.query(
                `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date
                 FROM loan_master WHERE loancaseno::text = $1`,
                [dto.loancaseno]
            );
            if (loanRows.length === 0) {
                throw new BadRequestException(`Loan case ${dto.loancaseno} not found in loan_master`);
            }
            const loan = loanRows[0];
            const currentBalance = parseFloat(loan.balance || 0);
            const payment = parseFloat(dto.paymentAmount as any);

            if (payment <= 0) throw new BadRequestException('Payment amount must be greater than zero');
            if (currentBalance <= 0) throw new BadRequestException(`Loan ${dto.loancaseno} is already fully repaid`);

            const asOf = dto.asOfDate && !isNaN(dto.asOfDate.getTime()) ? dto.asOfDate : new Date();
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
            await queryRunner.query(
                `UPDATE loan_master SET balance = $1 WHERE loancaseno::text = $2`,
                [newBalance, dto.loancaseno]
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
    ): Promise<{ totalPrincipalPaid: number; totalInterestCollected: number }> {
        const rows = await runner.query(
            `SELECT COALESCE(SUM(principal_amount), 0) as principal_paid,
                    COALESCE(SUM(interest_amount), 0) as interest_paid
             FROM loan_repayment_ledger
             WHERE loancaseno = $1 AND payment_date <= $2`,
            [loancaseno, asOfDate]
        );
        return {
            totalPrincipalPaid: Math.round((parseFloat(rows[0]?.principal_paid) || 0) * 100) / 100,
            totalInterestCollected: Math.round((parseFloat(rows[0]?.interest_paid) || 0) * 100) / 100,
        };
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
     * Early closure quote for a loan, per the user's explicit reconciliation
     * spec (must move in lockstep with executeEarlyClosure or the quote and
     * what actually gets posted disagree):
     *
     *   outstandingPrincipal = loan_amt − principal actually paid, read from
     *     loan_repayment_ledger — never derived from remaining EMI amounts
     *     or a cached balance column.
     *   closureInterest = compulsorySlotInterest (always included, never
     *     waived for closing early) + rbAdjustment, where rbAdjustment =
     *     (true RB interest accrued for installments 1..k) − (flat interest
     *     actually collected so far). Positive means the member paid less
     *     real interest than accrued and owes the difference; negative means
     *     they overpaid under the flat schedule and it offsets what's owed.
     *   + tiered penal on any installment still unpaid + any manual
     *     adjustment.
     *
     * No RB interest, and no flat EMI interest, from installments after the
     * closure point (k) is ever included — interest on a month that hasn't
     * started yet is never charged. Historical ledger rows are only read
     * here, never rewritten. Loans disbursed before loan_rb_schedule existed
     * have nothing to reconcile against — falls back to the old
     * flat-interest-on-unpaid-installments basis for those.
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
    ): Promise<any> {
        const loanRows = await this.dataSource.query(
            `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date
             FROM loan_master WHERE loancaseno::text = $1`,
            [loancaseno]
        );
        if (loanRows.length === 0) {
            throw new BadRequestException(`Loan case ${loancaseno} not found in loan_master`);
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

            const { totalPrincipalPaid, totalInterestCollected } = await this.getLedgerHistoryTotals(queryRunner, loancaseno, asOf);
            const { rbInterestTillClosure, totalRBInterestFullSchedule, hasRbSchedule } =
                await this.getRbScheduleTotals(queryRunner, loancaseno, k);

            const outstandingPrincipal = Math.round((loanAmt - totalPrincipalPaid) * 100) / 100;
            const penalInterest = Math.round(unpaid.reduce((sum, i) => sum + i.penalDue, 0) * 100) / 100;

            let compulsorySlotInterest = 0;
            let rbAdjustment = 0;
            let closureInterest: number;
            if (hasRbSchedule) {
                compulsorySlotInterest = Math.round((instalAmt * noOfInstal - loanAmt - totalRBInterestFullSchedule) * 100) / 100;
                rbAdjustment = Math.round((rbInterestTillClosure - totalInterestCollected) * 100) / 100;
                closureInterest = Math.round((compulsorySlotInterest + rbAdjustment) * 100) / 100;
            } else {
                closureInterest = Math.round(unpaid.reduce((sum, i) => sum + i.interestDue, 0) * 100) / 100;
            }

            const finalClosureAmount = Math.round((
                outstandingPrincipal + closureInterest + penalInterest + adjustment
            ) * 100) / 100;

            const rdShareAdjustment = applyRdShare
                ? await this.loanEligibility.getRdShareClosureAdjustment(loan.mbno, finalClosureAmount)
                : null;
            const payableByMember = rdShareAdjustment ? rdShareAdjustment.payableByMember : finalClosureAmount;

            return {
                loanCaseNo: loancaseno,
                closureDate: toLocalDateString(asOf),
                outstandingPrincipal,
                compulsorySlotInterest,
                rbInterestTillClosure,
                flatInterestCollected: totalInterestCollected,
                rbAdjustment,
                closureInterest,
                penalInterest,
                adjustment,
                finalClosureAmount,
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
                totalRBInterestFullSchedule,
                // False for loans disbursed before loan_rb_schedule existed —
                // closureInterest then falls back to the flat method and the
                // slot/RB breakdown above doesn't apply.
                hasRbSchedule,
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
            const loanRows = await queryRunner.query(
                `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date
                 FROM loan_master WHERE loancaseno::text = $1`,
                [loancaseno]
            );
            if (loanRows.length === 0) {
                throw new BadRequestException(`Loan case ${loancaseno} not found in loan_master`);
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

            // Single shared pooling logic (see getInstallmentStatus's doc
            // comment) — no separate month-bucketed implementation anymore,
            // so this can never disagree with the quote calculateEarlyClosure
            // just showed the operator. includeFuture=true keeps this
            // covering every remaining installment, not just the due ones.
            const installments = await this.getInstallmentStatus(queryRunner, loancaseno, loan, asOf, true);
            const k = installments.filter(i => i.isDue).length;

            // Read historical ledger/RB totals BEFORE this closure's own
            // ledger inserts happen below, or they'd double-count against
            // themselves.
            const { totalPrincipalPaid, totalInterestCollected } = await this.getLedgerHistoryTotals(queryRunner, loancaseno, asOf);
            const { rbInterestTillClosure, totalRBInterestFullSchedule, hasRbSchedule } =
                await this.getRbScheduleTotals(queryRunner, loancaseno, k);

            const outstandingPrincipal = Math.round((loanAmt - totalPrincipalPaid) * 100) / 100;

            // Closure interest reconciliation (see calculateEarlyClosure's
            // matching doc comment) — compulsory Slot 1/2 interest always
            // applies, plus true-up between RB interest accrued for
            // installments 1..k and flat interest actually collected so far.
            // Posted as a single lump ledger row below rather than folded
            // into individual installment rows, since the true-up isn't
            // attributable to any one installment.
            let compulsorySlotInterest = 0;
            let rbAdjustment = 0;
            let closureInterest = 0;
            if (hasRbSchedule) {
                compulsorySlotInterest = Math.round((instalAmt * noOfInstal - loanAmt - totalRBInterestFullSchedule) * 100) / 100;
                rbAdjustment = Math.round((rbInterestTillClosure - totalInterestCollected) * 100) / 100;
                closureInterest = Math.round((compulsorySlotInterest + rbAdjustment) * 100) / 100;
            }

            let penalInterest = 0;
            let fallbackFlatInterest = 0; // only accumulated/used when hasRbSchedule is false

            for (const inst of installments) {
                if (inst.isFullyPaid) continue;

                // Loans with an RB schedule have their interest fully handled
                // by the single lump reconciliation row below — each
                // installment row here carries principal (and penal) only, to
                // avoid double-charging interest. Loans with no RB schedule
                // (disbursed before this feature existed) fall back to the
                // old flat per-installment interest. inst.interestDue and
                // inst.penalDue are already 0 for a future (not-yet-due)
                // installment, per getInstallmentStatus.
                const interestForRow = hasRbSchedule ? 0 : inst.interestDue;
                if (!hasRbSchedule) fallbackFlatInterest += interestForRow;
                penalInterest += inst.penalDue;

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

            if (hasRbSchedule && closureInterest !== 0) {
                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,0,0,$8,$9,$10)`,
                    [
                        loan.mbno, loancaseno, loan.loantype, asOf, asOf.getMonth() + 1, asOf.getFullYear(),
                        closureInterest, receiptNo || null,
                        `Early Closure - Interest Reconciliation (Slot Rs.${compulsorySlotInterest.toFixed(2)} + RB Adjustment Rs.${rbAdjustment.toFixed(2)})`,
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

            await queryRunner.query(`UPDATE loan_master SET balance = 0 WHERE loancaseno::text = $1`, [loancaseno]);

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

            const totalClosureInterest = hasRbSchedule ? closureInterest : fallbackFlatInterest;
            const finalClosureAmount = Math.round((
                outstandingPrincipal + totalClosureInterest + penalInterest + adjustment
            ) * 100) / 100;

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
            `SELECT mbno, loantype, loan_amt, balance, instal_amt, no_of_instal, penalrate, gracedays, smpenalpct, smpenaldiv, payment_date
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
