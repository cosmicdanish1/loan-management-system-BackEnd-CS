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
    delayMonths: number;
}

export function round2(x: number): number {
    return Math.round(x * 100) / 100;
}

/**
 * How loan money is rounded — both the constant monthly interest when an EMI
 * is sized, and the early-closure line items.
 *
 * The society's manual/legacy worksheets work in whole rupees: a constant
 * monthly interest of 1687.50 is written as 1688 and then multiplied through
 * every later step (NR months, the AP remaining-interest adjustment), and each
 * closure line is written as a whole rupee too. Keeping full paisa precision
 * makes our output drift a few rupees from the manual figure on every closure,
 * so NEAREST (half-up: .00–.49 down, .50–.99 up) reproduces the manual
 * calculation and is the default. NONE is the original 2-decimal behavior.
 */
export type LoanRoundingMode = 'NONE' | 'NEAREST' | 'UP' | 'DOWN';

export const LOAN_ROUNDING_MODES: LoanRoundingMode[] = ['NONE', 'NEAREST', 'UP', 'DOWN'];

/** Half-up at the rupee for NEAREST; falls back to 2 decimals for NONE. */
export function applyLoanRounding(value: number, mode: LoanRoundingMode): number {
    switch (mode) {
        case 'NEAREST': return Math.round(value);
        case 'UP': return Math.ceil(value);
        case 'DOWN': return Math.floor(value);
        default: return round2(value);
    }
}

/** The society's original hardcoded Slot 1 window: the 25th through the 5th. */
export const DEFAULT_SLOT1_START_DAY = 25;
export const DEFAULT_SLOT1_END_DAY = 5;

/**
 * There are always exactly TWO slots — that structure is the society's own
 * source of truth and does not change. Only Slot 1's day window is
 * configurable; Slot 2 is by definition every other day of the month, so it
 * can never be defined inconsistently with Slot 1 (no gaps, no overlap).
 *
 * The window may WRAP the month boundary, which the society's original
 * 25th–5th window does: when startDay > endDay the window is
 * "startDay..end-of-month, plus 1..endDay". When startDay <= endDay it's the
 * plain inclusive range (e.g. a future "Slot 1 = 1st–10th" would be 1..10,
 * leaving Slot 2 as the 11th onward).
 *
 * Days are clamped to 1..31 rather than validated against the specific
 * month's real length: a window ending on the 31st must still mean "to the
 * end of the month" in February. Anything non-numeric falls back to the
 * society's original window, so a missing or corrupt config can never
 * silently reclassify every loan.
 */
function normalizeSlotDay(value: number, fallback: number): number {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 31) return fallback;
    return n;
}

export function isInSlot1Window(
    day: number,
    slot1StartDay: number = DEFAULT_SLOT1_START_DAY,
    slot1EndDay: number = DEFAULT_SLOT1_END_DAY,
): boolean {
    const start = normalizeSlotDay(slot1StartDay, DEFAULT_SLOT1_START_DAY);
    const end = normalizeSlotDay(slot1EndDay, DEFAULT_SLOT1_END_DAY);
    // Wrapping window (25..31 plus 1..5) vs plain inclusive range (1..10).
    return start > end ? (day >= start || day <= end) : (day >= start && day <= end);
}

/**
 * Which slot an application date falls in, and how many months of delay that
 * slot carries.
 *
 * Both halves are configurable from the "Modify Business Rules" screen and
 * stored in system_configs — the delay months as
 * RULE_LOAN_SLOT1_DELAY_MONTHS / RULE_LOAN_SLOT2_DELAY_MONTHS, and the Slot 1
 * day window as RULE_LOAN_SLOT1_START_DAY / RULE_LOAN_SLOT1_END_DAY. Every
 * default here reproduces the society's original hardcoded behaviour (25th–5th
 * = Slot 1 = +1 month, everything else = Slot 2 = +2 months), so an unsaved or
 * unreachable config leaves pricing exactly as it is today.
 *
 * The resolved delay is frozen onto loan_master.delay_months at disbursement,
 * so changing any of these later never reprices or reschedules a loan that has
 * already gone out.
 */
export function determineLoanSlot(
    applicationDate: Date,
    slot1DelayMonths: number = 1,
    slot2DelayMonths: number = 2,
    slot1StartDay: number = DEFAULT_SLOT1_START_DAY,
    slot1EndDay: number = DEFAULT_SLOT1_END_DAY,
): LoanSlot {
    const day = applicationDate.getDate();
    if (isInSlot1Window(day, slot1StartDay, slot1EndDay)) {
        return { slot: 1, delayMonths: slot1DelayMonths };
    }
    return { slot: 2, delayMonths: slot2DelayMonths };
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
    delayMonths: number;
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
    slot1DelayMonths: number = 1,
    slot2DelayMonths: number = 2,
    roundingMode: LoanRoundingMode = 'NONE',
    slot1StartDay: number = DEFAULT_SLOT1_START_DAY,
    slot1EndDay: number = DEFAULT_SLOT1_END_DAY,
): ConstantEmiResult {
    const { slot, delayMonths } = determineLoanSlot(
        applicationDate, slot1DelayMonths, slot2DelayMonths, slot1StartDay, slot1EndDay,
    );
    const monthlyRate = annualRate / 1200;
    const { schedule, totalRBInterest } = buildReducingBalanceSchedule(loanAmt, annualRate, n);

    // Delay interest is always on the FULL original principal — never the
    // declining balance — because it represents the period before any
    // deduction (and therefore any principal reduction) has started at all.
    const delayInterest = round2(loanAmt * monthlyRate * delayMonths);
    const totalInterestForEMI = round2(totalRBInterest + delayInterest);
    const monthlyPrincipal = round2(loanAmt / n);
    // Rounded ONCE here, never again downstream: instal_amt below carries this
    // value permanently, and both getInstallmentStatus (monthlyInterest) and
    // calculateEarlyClosure (compulsorySlotInterest) re-derive from instal_amt,
    // so they inherit the same rounding without any per-month re-rounding.
    const monthlyInterestForEMI = applyLoanRounding(totalInterestForEMI / n, roundingMode);
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
