import { BadRequestException } from '@nestjs/common';
import { formatDateForDB } from './date-utils';

/**
 * ES-458: nothing may be posted on a day that has already been closed by Day-End, or inside a financial year that has
 * been closed. Before this check every posting door (receipt, payment voucher, savings, loan repayment, ...) accepted
 * any date, so a day that was already day-ended could still receive postings and its closed figures changed.
 *
 * Rules (nothing else is blocked):
 *  - a day is CLOSED when the working-date table has a row for that date with dayend_flag = 'Y';
 *  - a financial year is CLOSED when its yearend row has closed_at set and the date lies inside it.
 * A date with no working-date row (history before day-end was used, or days not reached yet) stays open, so the
 * migrated legacy history and normal day-to-day posting are not affected.
 *
 * Call it with the posting's own query runner / entity manager, before anything is written.
 */
export async function assertPostingDateOpen(
    runner: { query: (sql: string, params?: any[]) => Promise<any> },
    date: Date | string | null | undefined,
): Promise<void> {
    const day = toDayText(date);
    if (!day) return; // no date given: the caller uses the current clock, which is never inside a closed day

    const closedDay = await runner.query(
        `SELECT 1 FROM getworkingdate WHERE working_date::date = $1::date AND dayend_flag = 'Y' LIMIT 1`,
        [day],
    );
    if (closedDay.length > 0) {
        throw new BadRequestException(
            `The day ${day} is already closed (Day-End has been done). Nothing can be posted on a closed day.`,
        );
    }

    const closedYear = await runner.query(
        `SELECT yearcode FROM yearend
          WHERE closed_at IS NOT NULL AND start_date::date <= $1::date AND end_date::date >= $1::date
          LIMIT 1`,
        [day],
    );
    if (closedYear.length > 0) {
        throw new BadRequestException(
            `The date ${day} is inside financial year ${closedYear[0].yearcode}, which is closed. Nothing can be posted in a closed financial year.`,
        );
    }
}

/**
 * The WORKING DATE as YYYY-MM-DD: the day Day-End has not closed yet (the earliest open row of the working-date table,
 * the same row Day-End itself closes next). Day-End only ever moves this date forward, so a posting that takes its
 * date from here can never land on a closed day or run ahead of it. Returns null when the table has no open row
 * (Day-End was never set up): the caller then falls back to the current date.
 * The date is read as text (::date::text), so no time zone can shift it by a day.
 */
export async function getWorkingDateText(
    runner: { query: (sql: string, params?: any[]) => Promise<any> },
): Promise<string | null> {
    const rows = await runner.query(
        `SELECT working_date::date::text AS d FROM getworkingdate WHERE dayend_flag = 'N' ORDER BY working_date ASC LIMIT 1`,
    );
    return rows?.[0]?.d ?? null;
}

/** YYYY-MM-DD of a posting date (a date-only text is used as it is, a Date by its local calendar day) */
function toDayText(date: Date | string | null | undefined): string | null {
    if (date === null || date === undefined || date === '') return null;
    if (typeof date === 'string') {
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
        if (m) return m[1];
        const parsed = new Date(date);
        return isNaN(parsed.getTime()) ? null : formatDateForDB(parsed);
    }
    return isNaN(date.getTime()) ? null : formatDateForDB(date);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Date policy: which date a window puts on its entries (the working date, or the real date of the day)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** WORKING = the Day-End working date (the default for every window); SYSTEM = today's real date in India. */
export type DatePolicyMode = 'WORKING' | 'SYSTEM';

/** Where "today" is read: the SERVER clock in Indian time, never the clock of the user's PC (which can be wrong). */
export const SYSTEM_TIME_ZONE = 'Asia/Kolkata';

/** Today's real date as YYYY-MM-DD in Indian time. */
export function systemDateText(now: Date = new Date()): string {
    // 'en-CA' formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: SYSTEM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * The mode the client chose for a window (Day End > Date settings). A window with no row, or a database that does
 * not have the table yet, is WORKING: the default for everything.
 * The table is looked up with to_regclass first, because a failed query inside a transaction would abort it.
 */
export async function getDatePolicyMode(
    runner: { query: (sql: string, params?: any[]) => Promise<any> },
    windowKey: string,
): Promise<DatePolicyMode> {
    const exists = await runner.query(`SELECT to_regclass('public.window_date_policy') AS t`);
    if (!exists?.[0]?.t) return 'WORKING';
    const rows = await runner.query(`SELECT mode FROM window_date_policy WHERE window_key = $1`, [windowKey]);
    return String(rows?.[0]?.mode ?? 'WORKING').toUpperCase() === 'SYSTEM' ? 'SYSTEM' : 'WORKING';
}

/**
 * The one place a window gets its posting date from. WORKING gives the open Day-End working date (today's real date
 * when Day-End was never set up); SYSTEM gives today's real date in Indian time. The date is always YYYY-MM-DD.
 * The caller still runs assertPostingDateOpen on it (a closed day or a closed financial year refuses the posting).
 */
export async function resolvePostingDate(
    runner: { query: (sql: string, params?: any[]) => Promise<any> },
    windowKey: string,
): Promise<{ date: string; mode: DatePolicyMode; source: 'working-date' | 'system-date' }> {
    const mode = await getDatePolicyMode(runner, windowKey);
    if (mode === 'SYSTEM') return { date: systemDateText(), mode, source: 'system-date' };
    const working = await getWorkingDateText(runner);
    return working
        ? { date: working, mode, source: 'working-date' }
        : { date: systemDateText(), mode, source: 'system-date' }; // Day-End never set up: nothing else to use
}

/** A YYYY-MM-DD posting date as a Date at local midnight (what the date columns of the books store). */
export function postingDateAsDate(date: string): Date {
    return new Date(`${date}T00:00:00`);
}
