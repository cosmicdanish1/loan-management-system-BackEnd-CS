export interface ScheduleSeedRepayment {
    date: string;
    principalAmount: number;
    interestAmount: number;
}

/**
 * BSP deductions before a schedule's first due month belong to the predecessor
 * payroll cycle, whether the boundary is origination or consolidation.
 */
export function isSlotDelayPayroll(
    repaymentDate: string,
    effectiveDate: string,
    firstDueMonth: string,
    nextEventDate?: string,
): boolean {
    const paymentDay = repaymentDate.slice(0, 10);
    return paymentDay >= effectiveDate.slice(0, 10)
        && paymentDay.slice(0, 7) < firstDueMonth.slice(0, 7)
        && (!nextEventDate || paymentDay < nextEventDate.slice(0, 10));
}

/**
 * Pick the earliest normal fixed-principal repayment in a schedule window.
 * A one-off tiny amount is not reliable evidence of the contractual EMI; it
 * may be a payoff residue or an adjustment. Require the same rounded
 * principal to appear in a different calendar month within six months.
 */
export function selectFirstRecurringPrincipal<T extends ScheduleSeedRepayment>(
    rows: T[],
): T | undefined {
    const ordered = rows
        .filter(row => Number.isFinite(row.principalAmount) && row.principalAmount > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

    for (const candidate of ordered) {
        const candidateMonth = candidate.date.slice(0, 7);
        const recurringMonths = new Set(
            ordered
                .filter(row => row.date.slice(0, 7) >= candidateMonth
                    && row.date.slice(0, 7) <= addMonths(candidateMonth, 6)
                    && Math.abs(row.principalAmount - candidate.principalAmount) <= 0.01)
                .map(row => row.date.slice(0, 7)),
        );
        if (recurringMonths.size >= 2) return candidate;
    }

    return undefined;
}

function addMonths(yearMonth: string, count: number): string {
    const [year, month] = yearMonth.split('-').map(Number);
    const date = new Date(year, month - 1 + count, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
