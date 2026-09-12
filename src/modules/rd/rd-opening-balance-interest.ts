/**
 * Opening-balance interest — the second of the two independent RD interest
 * calculators. Walks the member's rd_balance_events timeline (every
 * OPENING/WITHDRAWAL/LOAN_ADDITION/*_INTEREST_CREDIT event denormalizes its
 * own resultingBalance at write time — see rd-balance-events.service.ts)
 * and computes balance x monthly-rate x months-held for each period,
 * summing across the financial year.
 *
 * Two month-boundary rules, both taken directly from the user's spec
 * (section 22, "Interest on Loan-Linked RD Addition", and section 24's
 * worked "Combined Withdrawal + Loan Addition Example" — reproduced exactly
 * by this implementation, see the RD build's Step 12 verification):
 *
 *   1. A WITHDRAWAL takes effect IMMEDIATELY — the lower balance starts
 *      earning interest from the same calendar month the withdrawal
 *      happens in (the OLD balance's period ends at the end of the
 *      PRECEDING month).
 *   2. A LOAN_ADDITION is delayed ONE calendar month — the OLD (lower)
 *      balance keeps earning interest through the end of the addition's
 *      own month, and the new (higher) balance only starts from the
 *      FOLLOWING month.
 *
 * Every period boundary is therefore a whole-month cutover, not an exact
 * date — two events landing in the same calendar month collapse to a
 * single (possibly zero-length) period, and the day-of-month on any event
 * is irrelevant to the interest math (matches rd-interest-chart.ts's own
 * whole-month convention). The final period's end boundary is one month
 * PAST the financial year's last month — not the FY-end date itself — so
 * that its own last calendar month is included in the count on the same
 * terms as every interior period (an off-by-one this file used to have:
 * using fyEndDate directly as the terminal boundary silently dropped the
 * FY's final month from the last period's tally).
 *
 * Deliberately never touches rd_installment_ledger or the pattern engine's
 * eligibility verdict — this calculator only ever sees what the balance
 * WAS and for how long, per the user's explicit instruction that the two
 * interest figures must be computed independently and only added together
 * at the very end (in the financial-year-closing summary).
 */
import { monthsBetween, toDate } from './rd-date-math';

export interface BalanceEventInput {
    eventDate: string | Date;
    eventType: string;
    resultingBalance: number;
}

export interface BalancePeriod {
    fromDate: Date;
    toDate: Date;
    balance: number;
    monthsHeld: number;
    interest: number;
}

export interface OpeningBalanceInterestResult {
    periods: BalancePeriod[];
    totalInterest: number;
}

/** First-of-month Date marking when an event's resultingBalance starts
 *  counting toward opening-balance interest — this month itself for every
 *  event type except LOAN_ADDITION, which is pushed one month later. */
function effectiveMonthStart(event: BalanceEventInput): Date {
    const d = toDate(event.eventDate);
    const monthOffset = event.eventType === 'LOAN_ADDITION' ? 1 : 0;
    return new Date(d.getFullYear(), d.getMonth() + monthOffset, 1);
}

export function calculateOpeningBalanceInterest(
    events: BalanceEventInput[],
    annualRatePercent: number,
    fyEndDate: string | Date,
): OpeningBalanceInterestResult {
    if (events.length === 0) return { periods: [], totalInterest: 0 };
    const fyEnd = toDate(fyEndDate);
    // One month past the FY's last month — see docstring above.
    const fyBoundary = new Date(fyEnd.getFullYear(), fyEnd.getMonth() + 1, 1);

    const sorted = [...events]
        .map((event) => ({ event, effectiveMonth: effectiveMonthStart(event) }))
        .sort((a, b) => a.effectiveMonth.getTime() - b.effectiveMonth.getTime());

    const periods: BalancePeriod[] = sorted.map(({ event, effectiveMonth }, i) => {
        const nextBoundary = i + 1 < sorted.length ? sorted[i + 1].effectiveMonth : fyBoundary;
        const monthsHeld = Math.max(0, monthsBetween(effectiveMonth, nextBoundary));
        const interest = Math.round(event.resultingBalance * (annualRatePercent / 100) * (monthsHeld / 12) * 100) / 100;
        return { fromDate: effectiveMonth, toDate: nextBoundary, balance: event.resultingBalance, monthsHeld, interest };
    });

    const totalInterest = Math.round(periods.reduce((sum, p) => sum + p.interest, 0) * 100) / 100;
    return { periods, totalInterest };
}
