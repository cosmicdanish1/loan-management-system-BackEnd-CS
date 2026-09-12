/**
 * RD installment interest — pure formula, no lookup table, per the user's
 * explicit decision ("go with formula, chart has very little issue we will
 * fix it"): the society's printed chart matches this formula exactly for
 * April every tier, and drifts by a few paise in later months (its own
 * historical rounding, not something to reverse-engineer) — the user chose
 * to move forward on the clean formula rather than the printed chart's
 * exact figures.
 *
 * Interest = installment x annual rate x remaining months / 12
 * April=12 remaining months ... March=1 remaining month.
 */

/** Calendar month number (1=Jan .. 12=Dec) -> months remaining until the
 *  financial year's March close, for a financial-year month index. April's
 *  installment remains invested 12 months, March's remains 1. */
const FY_MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

/** Given a calendar month (1-12), how many months of the April-March
 *  financial year remain from (and including) that month through March. */
export function remainingMonthsInFinancialYear(calendarMonth: number): number {
    const idx = FY_MONTH_ORDER.indexOf(calendarMonth);
    if (idx === -1) throw new Error(`Invalid calendar month: ${calendarMonth}`);
    return 12 - idx;
}

/** Interest a single month's RD installment earns for however many months
 *  of the financial year it remains invested, per the user's formula. */
export function installmentInterest(
    monthlyInstallment: number,
    annualRatePercent: number,
    remainingMonths: number,
): number {
    const raw = monthlyInstallment * (annualRatePercent / 100) * (remainingMonths / 12);
    return Math.round(raw * 100) / 100;
}

/** The full year's chart for one monthly RD amount — one row per calendar
 *  month (April first, March last), matching the society's printed layout. */
export interface RdChartRow {
    calendarMonth: number;
    monthLabel: string;
    remainingMonths: number;
    interest: number;
}

const MONTH_LABELS: Record<number, string> = {
    1: 'January', 2: 'February', 3: 'March', 4: 'April', 5: 'May', 6: 'June',
    7: 'July', 8: 'August', 9: 'September', 10: 'October', 11: 'November', 12: 'December',
};

export function buildRdChart(monthlyInstallment: number, annualRatePercent: number): RdChartRow[] {
    return FY_MONTH_ORDER.map((calendarMonth) => {
        const remainingMonths = remainingMonthsInFinancialYear(calendarMonth);
        return {
            calendarMonth,
            monthLabel: MONTH_LABELS[calendarMonth],
            remainingMonths,
            interest: installmentInterest(monthlyInstallment, annualRatePercent, remainingMonths),
        };
    });
}

/** The full year's total interest for a monthly RD amount, paid on time
 *  every month — i.e. the "full annual interest" figure the eligibility
 *  engine grants when a member qualifies. Sums the same per-month figures
 *  buildRdChart() shows, so the displayed chart and the credited total can
 *  never disagree. */
export function fullYearInstallmentInterest(monthlyInstallment: number, annualRatePercent: number): number {
    const total = buildRdChart(monthlyInstallment, annualRatePercent)
        .reduce((sum, row) => sum + row.interest, 0);
    return Math.round(total * 100) / 100;
}
