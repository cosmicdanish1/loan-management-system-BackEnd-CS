/**
 * RD installment interest — one of the two independent interest calculators
 * per the user's explicit spec (never combined with the opening-balance
 * calculator's output except by simple addition, at the very end, in the
 * financial-year-closing summary — see rd-opening-balance-interest.ts's
 * own docstring for the other half).
 *
 * Only PAID installments are considered here — an installment never paid
 * earns nothing, per the user's explicit "no arrears carried forward, only
 * interest on what was actually paid" decision. The caller is responsible
 * for filtering to paid rows only (rd_installment_ledger rows with
 * paid_amount >= expected_amount).
 */
import { installmentInterest, remainingMonthsInFinancialYear } from './rd-interest-chart';
import { toDate } from './rd-date-math';

export interface PaidInstallmentInput {
    dueDate: string | Date;
    paidDate: string | Date;
    paidAmount: number;
}

export interface InstallmentInterestRow {
    dueDate: Date;
    paidDate: Date;
    paidAmount: number;
    remainingMonthsUsed: number;
    interest: number;
}

export interface RdInstallmentInterestResult {
    fullInterestEligible: boolean;
    rows: InstallmentInterestRow[];
    totalInterest: number;
}

/** Remaining months to use for a LATE-paid installment when the member is
 *  NOT eligible for the "as if paid on time" bonus: counted from the actual
 *  paid month, not the due month, and clamped to zero once the financial
 *  year has already closed (an installment cleared after year-end earned
 *  nothing THIS year — it belongs to whatever settles it next year). */
function remainingMonthsFromActualPayment(paidDate: Date, fyEndDate: Date): number {
    if (paidDate > fyEndDate) return 0;
    return remainingMonthsInFinancialYear(paidDate.getMonth() + 1);
}

/**
 * fullInterestEligible (the pattern engine's verdict, or an authority
 * override standing in for it) decides which remaining-months figure
 * applies to a LATE payment: eligible members get the full chart formula as
 * if every installment had been paid on its due date (the "bonus" a clean
 * or tolerably-recovered payment record earns); ineligible members get the
 * honest, reduced figure based on when the money was actually paid in.
 * On-time installments are unaffected either way — same figure both ways,
 * since due date and paid date fall in the same month.
 *
 * An eligible member's bonus is a FLOOR, never a cap: if the installment was
 * actually paid even earlier than its due date, the honest actual-payment
 * figure is larger than the due-date figure, and the eligible member is
 * entitled to that larger amount too (the money really was invested longer)
 * — so the eligible branch takes the max of the two instead of the due-date
 * figure alone. Without this, an early payment could make an INELIGIBLE
 * member's honest figure exceed what the "bonus" formula gave an eligible
 * member for the same due date, which would invert the whole point of the
 * eligibility bonus.
 */
export function calculateRdInstallmentInterest(
    paidInstallments: PaidInstallmentInput[],
    annualRatePercent: number,
    fullInterestEligible: boolean,
    fyEndDate: string | Date,
): RdInstallmentInterestResult {
    const fyEnd = toDate(fyEndDate);
    const rows: InstallmentInterestRow[] = paidInstallments.map((inst) => {
        const due = toDate(inst.dueDate);
        const paid = toDate(inst.paidDate);
        const remainingMonthsUsed = fullInterestEligible
            ? Math.max(remainingMonthsInFinancialYear(due.getMonth() + 1), remainingMonthsFromActualPayment(paid, fyEnd))
            : remainingMonthsFromActualPayment(paid, fyEnd);
        const interest = installmentInterest(inst.paidAmount, annualRatePercent, remainingMonthsUsed);
        return { dueDate: due, paidDate: paid, paidAmount: inst.paidAmount, remainingMonthsUsed, interest };
    });
    const totalInterest = Math.round(rows.reduce((sum, r) => sum + r.interest, 0) * 100) / 100;
    return { fullInterestEligible, rows, totalInterest };
}
