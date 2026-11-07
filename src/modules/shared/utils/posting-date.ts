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
