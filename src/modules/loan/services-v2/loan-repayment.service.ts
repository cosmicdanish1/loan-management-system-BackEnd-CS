import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

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
    /** Test-only clock override, NOT exposed on the public controller/DTO —
     *  lets a script simulate "today" for penal/overdue math so a full year
     *  of history can be built through this real method instead of faked in
     *  the database. Omit in every real call; defaults to the real clock. */
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
}

/** Real number of days in a given month (year, 0-indexed month). */
function daysInMonth(year: number, month0: number): number {
    return new Date(year, month0 + 1, 0).getDate();
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
    constructor(private readonly dataSource: DataSource) {}

    /**
     * Builds the month-by-month installment schedule for a loan using the
     * equalised-interest method (constant principal + constant interest),
     * and reconciles it against what's already been recorded in
     * loan_repayment_ledger. Only installments whose due month has started
     * on or before `asOfDate` are included, oldest first.
     *
     * This is the single source of truth for both oldest-first recovery
     * order and early-closure interest calculation — both need the same
     * "what's actually still owed, per installment" answer.
     */
    private async getInstallmentStatus(
        queryRunner: QueryRunner,
        loancaseno: string,
        loan: any,
        asOfDate: Date = new Date(),
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

            // Month-granular "has this installment's month started" check —
            // a deliberate business rule, not a day-count. Interest in this
            // system is a flat monthly charge, never day-prorated, so an
            // installment becomes due for the whole of its month starting
            // day 1, regardless of the exact disbursement-anniversary day the
            // schedule happens to assign it. (This supersedes an exact-date
            // check made earlier in this same session for a different,
            // narrower problem — that fix predates this business rule.)
            const monthsAhead = (dueDate.getFullYear() - asOfYear) * 12 + (dueDate.getMonth() - asOfMonth0);
            if (monthsAhead > 0) break; // due month hasn't started yet

            const principalApplied = Math.min(monthlyPrincipal, principalPool);
            principalPool -= principalApplied;
            const interestApplied = Math.min(monthlyInterest, interestPool);
            interestPool -= interestApplied;

            const paid = {
                principal: Math.round(principalApplied * 100) / 100,
                interest: Math.round(interestApplied * 100) / 100,
            };
            const principalDue = isSettled
                ? 0
                : Math.max(0, Math.round((monthlyPrincipal - principalApplied) * 100) / 100);
            const interestDue = isSettled
                ? 0
                : Math.max(0, Math.round((monthlyInterest - interestApplied) * 100) / 100);
            const isFullyPaid = principalDue <= 0 && interestDue <= 0;

            const { tier, monthsOverdue, penalDue } = computeTier(
                principalDue, isFullyPaid, dueDate, asOfDate,
                graceDayOfMonth, penalRateAnnual, sameMonthPenalPct, sameMonthPenalDivisor,
            );

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
     * as a straight principal prepayment.
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

            // Anything left after every due installment is cleared is a plain
            // principal prepayment (paying ahead of schedule). Attribute it to
            // the next not-yet-due installment's own month, not the payment
            // date's month — otherwise it collides in the statement with the
            // installment that was just fully paid off in the same month.
            if (remaining > 0.004 && totalPrincipalApplied < currentBalance) {
                const prepay = Math.round(Math.min(remaining, currentBalance - totalPrincipalApplied) * 100) / 100;
                if (prepay > 0) {
                    const noOfInstal = parseInt(loan.no_of_instal, 10) || 0;
                    const nextInstallmentNo = installments.length + 1;
                    let nextDueDate: Date | null = null;
                    if (nextInstallmentNo <= noOfInstal) {
                        nextDueDate = new Date(loan.payment_date);
                        nextDueDate.setMonth(nextDueDate.getMonth() + nextInstallmentNo);
                    }
                    const prepayMonth = nextDueDate ? nextDueDate.getMonth() + 1 : asOf.getMonth() + 1;
                    const prepayYear = nextDueDate ? nextDueDate.getFullYear() : asOf.getFullYear();

                    await queryRunner.query(
                        `INSERT INTO loan_repayment_ledger
                            (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                             principal_amount, interest_amount, penal_amount, months_overdue,
                             receipt_no, narration, posted_by)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, $9, $10, $11)`,
                        [
                            dto.mbno, dto.loancaseno, loan.loantype, asOf,
                            prepayMonth, prepayYear,
                            prepay, prepay,
                            dto.receiptNo || null,
                            dto.narration || (nextDueDate
                                ? `Advance Principal Prepayment (toward installment #${nextInstallmentNo})`
                                : 'Advance Principal Prepayment'),
                            dto.username || 'system'
                        ]
                    );
                    totalPrincipalApplied += prepay;
                    remaining -= prepay;
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
     * Early closure quote for a loan: outstanding principal (already accurate
     * since recordLoanRepayment only reduces it by actual principal paid) +
     * the flat interest and tiered penal on every unpaid installment,
     * including the one covering the closure date's own current month —
     * folded in via getInstallmentStatus's month-granular due check exactly
     * like any other unpaid month. There is deliberately no separate
     * day-prorated "stub" interest calculation: interest is never day-
     * prorated in this system (see computeTier's doc comment), so once the
     * current month has started, its installment is already due in full.
     * Installments in months that haven't started yet are never charged.
     */
    async calculateEarlyClosure(
        loancaseno: string,
        closureDate?: Date,
        adjustment: number = 0,
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

            const previousOverdueInterest = Math.round(unpaid.reduce((sum, i) => sum + i.interestDue, 0) * 100) / 100;
            const penalInterest = Math.round(unpaid.reduce((sum, i) => sum + i.penalDue, 0) * 100) / 100;
            const outstandingPrincipal = Math.round((parseFloat(loan.balance) || 0) * 100) / 100;

            const finalClosureAmount = Math.round((
                outstandingPrincipal + previousOverdueInterest + penalInterest + adjustment
            ) * 100) / 100;

            return {
                loanCaseNo: loancaseno,
                closureDate: asOf.toISOString().split('T')[0],
                outstandingPrincipal,
                previousOverdueInterest,
                penalInterest,
                adjustment,
                finalClosureAmount,
                unpaidInstallments: unpaid.map(i => ({
                    installmentNo: i.installmentNo,
                    dueDate: i.dueDate.toISOString().split('T')[0],
                    principalDue: i.principalDue,
                    interestDue: i.interestDue,
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
     * quote), this actually settles the loan. Paying the quoted amount
     * through the regular recordLoanRepayment() waterfall does NOT fully
     * close a loan out: that waterfall only reconciles installments already
     * due, so any genuinely future (not-yet-started-month) installments'
     * principal gets dumped as an undifferentiated "prepayment" with no
     * per-installment ledger entry — loan_master.balance reaches zero, but
     * due-status/EMI-schedule still show those future installments as
     * unpaid. This writes a proper ledger entry for every remaining
     * installment, due or not — future ones principal-only, since interest
     * on a month that hasn't started is never charged — plus any manual
     * adjustment, before zeroing the balance.
     */
    async executeEarlyClosure(
        loancaseno: string,
        closureDate?: Date,
        adjustment: number = 0,
        postedBy: string = 'system',
        receiptNo?: string,
    ): Promise<{ success: boolean; message: string; finalClosureAmount: number }> {
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
            const penalRateAnnual = parseFloat(loan.penalrate) || 0;
            const graceDayOfMonth = parseInt(loan.gracedays, 10) || 0;
            const sameMonthPenalPct = parseFloat(loan.smpenalpct) || 0;
            const sameMonthPenalDivisor = parseFloat(loan.smpenaldiv) || 0;
            const disbursementDate = new Date(loan.payment_date);
            const monthlyPrincipal = noOfInstal > 0 ? loanAmt / noOfInstal : 0;
            const totalInterest = Math.max(0, instalAmt * noOfInstal - loanAmt);
            const monthlyInterest = noOfInstal > 0 ? totalInterest / noOfInstal : 0;
            const asOfYear = asOf.getFullYear();
            const asOfMonth0 = asOf.getMonth();

            const paidRows = await queryRunner.query(
                `SELECT payment_month, payment_year,
                        COALESCE(SUM(principal_amount), 0) as principal_paid,
                        COALESCE(SUM(interest_amount), 0) as interest_paid
                 FROM loan_repayment_ledger WHERE loancaseno = $1 GROUP BY payment_month, payment_year`,
                [loancaseno]
            );
            const paidMap = new Map<string, { principal: number; interest: number }>();
            for (const row of paidRows) {
                paidMap.set(`${row.payment_year}-${row.payment_month}`, {
                    principal: parseFloat(row.principal_paid) || 0,
                    interest: parseFloat(row.interest_paid) || 0,
                });
            }

            let previousOverdueInterest = 0;
            let penalInterest = 0;

            for (let n = 1; n <= noOfInstal; n++) {
                const dueDate = new Date(disbursementDate);
                dueDate.setMonth(dueDate.getMonth() + n);
                // Same month-granular check as getInstallmentStatus() — this loop
                // is a separate, duplicated implementation (doesn't call that
                // shared function), so it needs the identical rule or the actual
                // executed closure would disagree with the quote
                // calculateEarlyClosure just showed the operator.
                const monthsAhead = (dueDate.getFullYear() - asOfYear) * 12 + (dueDate.getMonth() - asOfMonth0);
                const isDue = monthsAhead <= 0;

                const key = `${dueDate.getFullYear()}-${dueDate.getMonth() + 1}`;
                const paid = paidMap.get(key) || { principal: 0, interest: 0 };
                const principalDue = Math.max(0, Math.round((monthlyPrincipal - paid.principal) * 100) / 100);
                // Interest on a month that hasn't started yet is never charged
                // — but "hasn't started" now means a genuinely later month, not
                // merely a later day-of-month within the closure date's own month.
                const interestDue = isDue ? Math.max(0, Math.round((monthlyInterest - paid.interest) * 100) / 100) : 0;

                if (principalDue <= 0 && interestDue <= 0) continue;

                let penalDue = 0;
                let monthsOverdue = 0;
                if (isDue) {
                    const isFullyPaid = principalDue <= 0 && interestDue <= 0;
                    const tierResult = computeTier(
                        principalDue, isFullyPaid, dueDate, asOf,
                        graceDayOfMonth, penalRateAnnual, sameMonthPenalPct, sameMonthPenalDivisor,
                    );
                    penalDue = tierResult.penalDue;
                    monthsOverdue = tierResult.monthsOverdue;
                    previousOverdueInterest += interestDue;
                    penalInterest += penalDue;
                }

                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue,
                         receipt_no, narration, posted_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                    [
                        loan.mbno, loancaseno, loan.loantype, asOf,
                        dueDate.getMonth() + 1, dueDate.getFullYear(),
                        Math.round((principalDue + interestDue + penalDue) * 100) / 100,
                        principalDue, interestDue, penalDue, monthsOverdue,
                        receiptNo || null,
                        isDue ? `Early Closure - Installment #${n}` : `Early Closure - Future Installment #${n} (principal only)`,
                        postedBy,
                    ]
                );
            }

            // No separate reducing-balance "stub" interest charge any more —
            // interest is never day-prorated in this system, so the closure
            // date's own current-month installment already carries its full
            // flat interest via the loop above (see calculateEarlyClosure's
            // matching doc comment).
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
                    [currentBalance, loan.mbno]
                );
            } else {
                await queryRunner.query(
                    `UPDATE member_balances SET regularloan = GREATEST(0, COALESCE(regularloan, 0) - $1) WHERE mbno = $2`,
                    [currentBalance, loan.mbno]
                );
            }

            const finalClosureAmount = Math.round((
                currentBalance + previousOverdueInterest + penalInterest + adjustment
            ) * 100) / 100;

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: `Loan ${loancaseno} closed early as of ${asOf.toISOString().split('T')[0]}. Final closure amount: ₹${finalClosureAmount.toLocaleString('en-IN')}.`,
                finalClosureAmount,
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

            return {
                loanCaseNo: loancaseno,
                oldestUnpaidInstallment: unpaid.length > 0 ? unpaid[0].installmentNo : null,
                unpaidInstallments: unpaid.map(i => ({
                    installmentNo: i.installmentNo,
                    dueDate: i.dueDate.toISOString().split('T')[0],
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
                -- Due date: the installment's own due day-of-month (from the loan's
                -- disbursement date), applied to this row's for-month/for-year.
                -- LEAST(...,28) avoids invalid dates (e.g. "Feb 30") when the
                -- disbursement day doesn't exist in every month.
                make_date(
                    lrl.payment_year, lrl.payment_month,
                    LEAST(EXTRACT(DAY FROM lm.payment_date)::int, 28)
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
