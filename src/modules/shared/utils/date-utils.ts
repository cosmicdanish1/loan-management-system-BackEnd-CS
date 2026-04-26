/**
 * Utility functions for date manipulation and parsing
 */

/**
 * Parses a date input string or Date object safely.
 * Specifically handles DD-MM-YYYY and DD/MM/YYYY formats which are common in frontend inputs
 * but can cause issues with standard JS Date constructor and PostgreSQL.
 * 
 * @param dateInput Any input value representing a date
 * @returns A valid JS Date object, or current date if invalid
 */
export function parseSafeDate(dateInput: any): Date {
    if (!dateInput) return new Date();
    if (dateInput instanceof Date) return dateInput;

    if (typeof dateInput === 'string') {
        // Handle DD-MM-YYYY
        const ddmmyyyy = dateInput.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
        if (ddmmyyyy) {
            return new Date(parseInt(ddmmyyyy[3]), parseInt(ddmmyyyy[2]) - 1, parseInt(ddmmyyyy[1]));
        }

        // Handle DD/MM/YYYY
        const ddmmyyyySlash = dateInput.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (ddmmyyyySlash) {
            return new Date(parseInt(ddmmyyyySlash[3]), parseInt(ddmmyyyySlash[2]) - 1, parseInt(ddmmyyyySlash[1]));
        }

        // ISO format check (YYYY-MM-DD or similar) - usually handled by new Date() correctly
    }

    const d = new Date(dateInput);
    // Return current date if the result is "Invalid Date"
    return isNaN(d.getTime()) ? new Date() : d;
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
