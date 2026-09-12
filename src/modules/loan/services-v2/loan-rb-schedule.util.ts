import { QueryRunner } from 'typeorm';

/**
 * This cooperative society's own loan-interest rule — NOT standard bank EMI
 * amortization. Two things distinguish it:
 *
 * 1. The underlying reducing-balance schedule uses EQUAL PRINCIPAL each
 *    month (loan_amt / n), with interest computed on the declining opening
 *    balance (openingBalance × monthlyRate). This is different from the
 *    standard bank method (equal total payment, principal grows over time) —
 *    confirmed with the user this is the intended method for this society.
 *
 * 2. Depending on which "slot" the application date falls in, 1 or 2 extra
 *    months of interest on the FULL original principal is added on top,
 *    because departmental/salary-deduction processing means the member holds
 *    the full disbursed amount for that long before EMI deduction starts.
 *    This extra interest does NOT change the RB schedule itself — it only
 *    feeds into sizing the constant EMI (see calculateConstantEmi below).
 *
 * The RB schedule this module produces is persisted separately
 * (loan_rb_schedule) from the flat instal_amt the member actually pays every
 * month — the RB schedule exists purely to answer "what has genuinely
 * accrued so far" for early-closure settlement. It is never used to decide
 * what a member's regular monthly payment is.
 */

export interface RbScheduleRow {
    installmentNo: number;
    openingBalance: number;
    rbInterest: number;
    principal: number;
    closingBalance: number;
}

export interface LoanSlot {
    slot: 1 | 2;
    delayMonths: 1 | 2;
}

function round2(x: number): number {
    return Math.round(x * 100) / 100;
}

/**
 * Slot 1: application date falls on/after the 25th of a month, OR on/before
 * the 5th of a month (the window spans a month boundary: 25th–5th).
 * Slot 2: the 6th through the 24th.
 */
export function determineLoanSlot(applicationDate: Date): LoanSlot {
    const day = applicationDate.getDate();
    if (day >= 25 || day <= 5) {
        return { slot: 1, delayMonths: 1 };
    }
    return { slot: 2, delayMonths: 2 };
}

/**
 * Builds the true reducing-balance schedule: n rows, equal principal each
 * month, interest computed on the declining opening balance. This is the
 * "underlying loan economics" schedule — never shown to the member as their
 * payment amount, only used for closure settlement and audit.
 */
export function buildReducingBalanceSchedule(
    loanAmt: number,
    annualRate: number,
    n: number,
): { schedule: RbScheduleRow[]; totalRBInterest: number } {
    const monthlyRate = annualRate / 1200;
    const monthlyPrincipal = round2(loanAmt / n);
    const schedule: RbScheduleRow[] = [];
    let balance = loanAmt;
    let totalRBInterest = 0;

    for (let i = 1; i <= n; i++) {
        const rbInterest = round2(balance * monthlyRate);
        // Final installment forced to exactly zero, absorbing any rounding
        // drift from n not dividing loanAmt evenly — same rounding policy
        // the constant-EMI side already uses elsewhere in this codebase.
        const closingBalance = i === n ? 0 : round2(balance - monthlyPrincipal);
        schedule.push({
            installmentNo: i,
            openingBalance: round2(balance),
            rbInterest,
            principal: monthlyPrincipal,
            closingBalance,
        });
        totalRBInterest += rbInterest;
        balance = closingBalance;
    }

    return { schedule, totalRBInterest: round2(totalRBInterest) };
}

export interface ConstantEmiResult {
    slot: 1 | 2;
    delayMonths: 1 | 2;
    monthlyRate: number;
    monthlyPrincipal: number;
    totalRBInterest: number;
    delayInterest: number;
    totalInterestForEMI: number;
    monthlyInterestForEMI: number;
    constantEMI: number;
    rbSchedule: RbScheduleRow[];
}

/**
 * The full calculation: slot → RB schedule → delay interest → constant EMI.
 * This is what disbursement calls to get the number a member actually pays
 * every month, plus the RB schedule to persist alongside it.
 */
export function calculateConstantEmi(
    loanAmt: number,
    annualRate: number,
    n: number,
    applicationDate: Date,
): ConstantEmiResult {
    const { slot, delayMonths } = determineLoanSlot(applicationDate);
    const monthlyRate = annualRate / 1200;
    const { schedule, totalRBInterest } = buildReducingBalanceSchedule(loanAmt, annualRate, n);

    // Delay interest is always on the FULL original principal — never the
    // declining balance — because it represents the period before any
    // deduction (and therefore any principal reduction) has started at all.
    const delayInterest = round2(loanAmt * monthlyRate * delayMonths);
    const totalInterestForEMI = round2(totalRBInterest + delayInterest);
    const monthlyPrincipal = round2(loanAmt / n);
    const monthlyInterestForEMI = round2(totalInterestForEMI / n);
    const constantEMI = round2(monthlyPrincipal + monthlyInterestForEMI);

    return {
        slot, delayMonths, monthlyRate, monthlyPrincipal,
        totalRBInterest, delayInterest, totalInterestForEMI, monthlyInterestForEMI,
        constantEMI, rbSchedule: schedule,
    };
}

/** Persists the RB schedule rows for a loan case — called once, at disbursement. */
export async function persistRbSchedule(
    queryRunner: QueryRunner,
    loancaseno: string,
    mbno: string,
    schedule: RbScheduleRow[],
): Promise<void> {
    await queryRunner.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [loancaseno]);
    for (const row of schedule) {
        await queryRunner.query(
            `INSERT INTO loan_rb_schedule
                (loancaseno, mbno, installment_no, opening_balance, rb_interest, principal, closing_balance)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [loancaseno, mbno, row.installmentNo, row.openingBalance, row.rbInterest, row.principal, row.closingBalance]
        );
    }
}
