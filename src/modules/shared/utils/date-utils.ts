import { BadRequestException } from '@nestjs/common';

/**
 * Utility functions for date manipulation and parsing
 */

/** true when day/month/year form a date that really exists (31-02-2026 does not) */
function isRealDayMonthYear(day: number, month: number, year: number): boolean {
    const d = new Date(year, month - 1, day);
    return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * Parses a date input string or Date object safely.
 * Specifically handles DD-MM-YYYY and DD/MM/YYYY formats which are common in frontend inputs
 * but can cause issues with standard JS Date constructor and PostgreSQL.
 *
 * An empty input (undefined, null, '') means "no date given" and gives the current date.
 * Text that is not a real date (31-02-2026, "not a date") is refused with a 400 instead of being
 * moved to another day or silently replaced by today.
 *
 * @param dateInput Any input value representing a date
 * @returns A valid JS Date object
 */
export function parseSafeDate(dateInput: any): Date {
    if (dateInput === undefined || dateInput === null || dateInput === '') return new Date();
    if (dateInput instanceof Date) {
        if (isNaN(dateInput.getTime())) throw new BadRequestException('Invalid date');
        return dateInput;
    }

    if (typeof dateInput === 'string') {
        const text = dateInput.trim();
        // DD-MM-YYYY or DD/MM/YYYY
        const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
        if (dmy) {
            const [day, month, year] = [parseInt(dmy[1], 10), parseInt(dmy[2], 10), parseInt(dmy[3], 10)];
            if (!isRealDayMonthYear(day, month, year)) throw new BadRequestException(`Invalid date '${dateInput}'`);
            return new Date(year, month - 1, day);
        }
        // YYYY-MM-DD (optionally followed by a time): the day must exist too
        const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
        if (iso && !isRealDayMonthYear(parseInt(iso[3], 10), parseInt(iso[2], 10), parseInt(iso[1], 10))) {
            throw new BadRequestException(`Invalid date '${dateInput}'`);
        }
    }

    const d = new Date(dateInput);
    if (isNaN(d.getTime())) throw new BadRequestException(`Invalid date '${dateInput}'`);
    return d;
}

/**
 * Formats a date to YYYY-MM-DD string for database queries
 * @param date JS Date object
 */
export function formatDateForDB(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * A date typed into a business form: must be a real date, not before 1950 and not more than `maxFutureDays`
 * ahead (default 31). 2099-01-01 or "yesterday" is a 400 with a message the user can act on, never a stored value.
 * Empty input means today.
 */
export function parseBusinessDate(dateInput: any, label = 'Date', maxFutureDays = 31): Date {
    let d: Date;
    try {
        d = parseSafeDate(dateInput);
    } catch {
        throw new BadRequestException(`${label} '${String(dateInput).slice(0, 30)}' is not a valid date. Use DD-MM-YYYY.`);
    }
    const limit = new Date();
    limit.setDate(limit.getDate() + maxFutureDays);
    if (d.getFullYear() < 1950) throw new BadRequestException(`${label} cannot be before 1950.`);
    if (d.getTime() > limit.getTime()) throw new BadRequestException(`${label} cannot be more than ${maxFutureDays} days in the future.`);
    return d;
}
