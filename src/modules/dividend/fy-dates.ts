/**
 * Financial-year dates for the dividend and credit steps.
 *
 * yearend stores naive timestamps that sit a few hours either side of midnight depending on who created the row
 * (year code 1 = 2026-04-01 00:00 UTC, year code 2 = 2027-03-31 18:30 UTC, i.e. 1 April IST). Reading them with
 * `new Date(...)` therefore depends on the timezone of the server. Adding 12 hours before casting to a date puts every
 * stored boundary on the intended calendar day, the same rule Group Insurance uses. (ES-600)
 */
export interface FinancialYearDates {
    yearcode: number;
    fyStart: string; // YYYY-MM-DD
    fyEnd: string;   // YYYY-MM-DD
    /** The year the financial year starts in; the dividend of the year is stored under it (dividend_master.year). */
    startYear: number;
    /** 2026-27 */
    label: string;
}

export const FY_DATE_COLUMNS_SQL =
    `to_char((start_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_start, ` +
    `to_char((end_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_end`;

/** 2026 -> "2026-27" */
export const fyLabelOf = (startYear: number): string => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

/** Start year of the Indian financial year (April to March) that a date falls in: 15 Feb 2027 -> 2026. */
export function fyStartYearOf(date: Date = new Date()): number {
    return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

export function toFinancialYearDates(row: { yearcode: any; fy_start: string; fy_end: string }): FinancialYearDates {
    const startYear = Number(String(row.fy_start).slice(0, 4));
    return { yearcode: Number(row.yearcode), fyStart: row.fy_start, fyEnd: row.fy_end, startYear, label: fyLabelOf(startYear) };
}
