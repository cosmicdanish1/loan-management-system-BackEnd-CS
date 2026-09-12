/**
 * Shared date-math for the RD system: the pattern engine and both interest
 * calculators all need "how many whole calendar months between two dates",
 * so it lives here once rather than three times. Deliberately whole-month
 * granularity (day-of-month is ignored) — matches the installment chart's
 * own whole-month convention (April=12 remaining months down to March=1).
 * This is pure arithmetic, not policy — sharing it does not combine the
 * calculators' independent outputs.
 */
export function toDate(d: string | Date): Date {
    return d instanceof Date ? d : new Date(d);
}

export function monthsBetween(from: Date, to: Date): number {
    return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/** Formats a Date's LOCAL calendar-date components (year/month/day) as
 *  'YYYY-MM-DD' — deliberately NOT toISOString(), which reads UTC
 *  components and silently shifts by a day for any timezone ahead of UTC.
 *  node-postgres parses a `timestamp` (no zone) column into a Date using
 *  LOCAL components (so a stored '2021-04-01' comes back correct via
 *  getDate()/getMonth()/getFullYear()), but when that same Date is later
 *  bound as a parameter into a `date`-typed column, its encoder reads UTC
 *  components instead — round-tripping via toISOString() would store the
 *  PREVIOUS calendar day for any positive UTC offset (confirmed live: IST
 *  turned an April 1 start_date into a stored March 31 event_date). Passing
 *  this plain date string instead sidesteps the mismatch entirely — Postgres
 *  parses 'YYYY-MM-DD' as an exact calendar date, no timezone involved. */
export function toDateOnlyString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
