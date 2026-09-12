/**
 * RD payment-pattern eligibility engine — ONE general rule-evaluator reading
 * a member's 12-month installment history, not six hardcoded pattern
 * matchers. The user's spec illustrated six patterns (A-F: fully regular,
 * one gap recovered early, gap at year-start, gap later in the year,
 * multiple gaps, gap never cleared) purely as EXAMPLES of what should and
 * shouldn't qualify for automatic full-annual-interest — the actual
 * decision here is driven entirely by the configurable RdRules thresholds
 * (Modify Business Rules -> RD System tab), so a policy change never needs
 * a code change.
 *
 * Output is a boolean gate (autoEligibleFullInterest) plus a human-readable
 * detected-pattern label for the audit trail — it does NOT compute any
 * interest itself (Step 8's two calculators do that) and does NOT decide
 * whether a still-unpaid installment earns interest (per the user's
 * explicit "no arrears carried forward, only interest on what was actually
 * paid" decision, that's enforced by the interest calculator only ever
 * summing paid installments, independent of this engine's verdict).
 */
import { RdRules } from './rd-business-rules';
import { monthsBetween, toDate } from './rd-date-math';

export type InstallmentStatus = 'PAID_ON_TIME' | 'PAID_LATE' | 'MISSED';

export interface InstallmentRecord {
    dueDate: string | Date;
    expectedAmount: number;
    paidAmount: number;
    paidDate: string | Date | null;
}

export interface InstallmentFact extends InstallmentRecord {
    status: InstallmentStatus;
    /** Whole calendar months between due date and paid date. null while
     *  still unpaid (MISSED) — there is no "late by" figure until it's paid. */
    monthsLate: number | null;
}

export interface PaymentGap {
    /** Index into the due-date-ordered fact array (0 = the FY's first
     *  installment, i.e. April or whenever the member's record starts). */
    startIndex: number;
    length: number;
    /** True only if every month in the gap was eventually paid (as an
     *  arrears clearance) — false if any month in it is still unpaid. */
    recovered: boolean;
    /** Longest clearance delay across the gap's months, if recovered. */
    recoveryDelayMonths: number | null;
    /** Consecutive on-time months immediately following the gap, within
     *  the same year's record. */
    trailingOnTimeRun: number;
}

export interface PatternEvaluation {
    totalDue: number;
    totalPaidOnTime: number;
    totalPaidLate: number;
    totalStillMissing: number;
    /** paidLate + stillMissing — every month that wasn't paid by its due
     *  date, whether or not it was later cleared. */
    totalNonOnTime: number;
    maxConsecutiveOnTime: number;
    longestGapMonths: number;
    gaps: PaymentGap[];
    autoEligibleFullInterest: boolean;
    disqualifyingReasons: string[];
    detectedPattern:
    | 'FULLY_REGULAR'
    | 'INITIAL_GAP_RECOVERED'
    | 'LATER_GAP_RECOVERED'
    | 'MULTIPLE_GAPS'
    | 'GAP_UNRECOVERED';
}

/** Classifies each installment as paid-on-time, paid-late (arrears
 *  clearance), or still missing. Input must already be sorted oldest-first
 *  (the caller reads rd_installment_ledger ordered by due_date ASC, which
 *  for a single financial year's rows is exactly April-first order). */
export function classifyInstallments(records: InstallmentRecord[]): InstallmentFact[] {
    return records.map((r) => {
        const due = toDate(r.dueDate);
        const paid = r.paidDate ? toDate(r.paidDate) : null;
        const isPaid = r.paidAmount >= r.expectedAmount && !!paid;
        if (!isPaid) {
            return { ...r, status: 'MISSED' as const, monthsLate: null };
        }
        const late = monthsBetween(due, paid!);
        return late <= 0
            ? { ...r, status: 'PAID_ON_TIME' as const, monthsLate: 0 }
            : { ...r, status: 'PAID_LATE' as const, monthsLate: late };
    });
}

/** Runs a member's classified installment history through the configured
 *  RD rules and returns the auto-eligibility verdict plus the facts that
 *  produced it, for the audit record. */
export function evaluateRdPaymentPattern(records: InstallmentRecord[], rules: RdRules): PatternEvaluation {
    const facts = classifyInstallments(records);
    const totalDue = facts.length;
    const totalPaidOnTime = facts.filter((f) => f.status === 'PAID_ON_TIME').length;
    const totalPaidLate = facts.filter((f) => f.status === 'PAID_LATE').length;
    const totalStillMissing = facts.filter((f) => f.status === 'MISSED').length;
    const totalNonOnTime = totalPaidLate + totalStillMissing;

    let maxConsecutiveOnTime = 0;
    let run = 0;
    for (const f of facts) {
        if (f.status === 'PAID_ON_TIME') {
            run++;
            maxConsecutiveOnTime = Math.max(maxConsecutiveOnTime, run);
        } else {
            run = 0;
        }
    }

    const gaps: PaymentGap[] = [];
    let i = 0;
    while (i < facts.length) {
        if (facts[i].status === 'PAID_ON_TIME') {
            i++;
            continue;
        }
        const start = i;
        let j = i;
        while (j < facts.length && facts[j].status !== 'PAID_ON_TIME') j++;
        const gapFacts = facts.slice(start, j);
        const recovered = gapFacts.every((f) => f.status === 'PAID_LATE');
        const recoveryDelayMonths = recovered
            ? Math.max(...gapFacts.map((f) => f.monthsLate ?? 0))
            : null;
        let trailingOnTimeRun = 0;
        for (let k = j; k < facts.length && facts[k].status === 'PAID_ON_TIME'; k++) trailingOnTimeRun++;
        gaps.push({ startIndex: start, length: j - start, recovered, recoveryDelayMonths, trailingOnTimeRun });
        i = j;
    }
    const longestGapMonths = gaps.reduce((max, g) => Math.max(max, g.length), 0);

    const reasons: string[] = [];

    if (totalNonOnTime > rules.RULE_RD_MAX_MISSED_INSTALLMENTS) {
        reasons.push(
            `${totalNonOnTime} installment(s) were not paid on time, exceeding the configured tolerance of ${rules.RULE_RD_MAX_MISSED_INSTALLMENTS}.`,
        );
    }
    if (longestGapMonths > rules.RULE_RD_MAX_PAYMENT_GAP_MONTHS) {
        reasons.push(
            `Longest gap was ${longestGapMonths} consecutive month(s), exceeding the configured maximum of ${rules.RULE_RD_MAX_PAYMENT_GAP_MONTHS}.`,
        );
    }
    if (gaps.length > 0 && maxConsecutiveOnTime < rules.RULE_RD_MIN_CONSECUTIVE_INSTALLMENTS) {
        reasons.push(
            `Longest run of on-time payments was ${maxConsecutiveOnTime} month(s), below the configured minimum of ${rules.RULE_RD_MIN_CONSECUTIVE_INSTALLMENTS}.`,
        );
    }
    if (gaps.length > 1 && !rules.RULE_RD_ALLOW_MULTIPLE_GAPS) {
        reasons.push(`${gaps.length} separate gaps found this year, but multiple gaps are not allowed by current policy.`);
    }
    for (const gap of gaps) {
        const monthLabel = `month ${gap.startIndex + 1}-${gap.startIndex + gap.length}`;
        if (!gap.recovered) {
            reasons.push(`Installment(s) at ${monthLabel} remain unpaid.`);
            continue;
        }
        if (gap.startIndex === 0 && !rules.RULE_RD_ALLOW_INITIAL_MISS_RECOVERY) {
            reasons.push(`Gap at the start of the year (${monthLabel}) is not eligible for recovery by current policy.`);
        }
        if (gap.startIndex > 0 && !rules.RULE_RD_ALLOW_LATER_MISS_RECOVERY) {
            reasons.push(`Gap later in the year (${monthLabel}) is not eligible for recovery by current policy.`);
        }
        if ((gap.recoveryDelayMonths ?? 0) > rules.RULE_RD_MAX_ARREARS_CLEARANCE_MONTHS) {
            reasons.push(
                `Gap at ${monthLabel} took ${gap.recoveryDelayMonths} month(s) to clear, exceeding the configured maximum of ${rules.RULE_RD_MAX_ARREARS_CLEARANCE_MONTHS}.`,
            );
        }
        const monthsRemainingAfterGap = facts.length - (gap.startIndex + gap.length);
        if (
            monthsRemainingAfterGap >= rules.RULE_RD_MIN_REGULAR_AFTER_RECOVERY &&
            gap.trailingOnTimeRun < rules.RULE_RD_MIN_REGULAR_AFTER_RECOVERY
        ) {
            reasons.push(
                `Only ${gap.trailingOnTimeRun} regular payment(s) followed the recovery at ${monthLabel}, below the configured minimum of ${rules.RULE_RD_MIN_REGULAR_AFTER_RECOVERY}.`,
            );
        }
    }

    let detectedPattern: PatternEvaluation['detectedPattern'];
    if (gaps.length === 0) detectedPattern = 'FULLY_REGULAR';
    else if (gaps.some((g) => !g.recovered)) detectedPattern = 'GAP_UNRECOVERED';
    else if (gaps.length > 1) detectedPattern = 'MULTIPLE_GAPS';
    else if (gaps[0].startIndex === 0) detectedPattern = 'INITIAL_GAP_RECOVERED';
    else detectedPattern = 'LATER_GAP_RECOVERED';

    return {
        totalDue,
        totalPaidOnTime,
        totalPaidLate,
        totalStillMissing,
        totalNonOnTime,
        maxConsecutiveOnTime,
        longestGapMonths,
        gaps,
        autoEligibleFullInterest: reasons.length === 0,
        disqualifyingReasons: reasons,
        detectedPattern,
    };
}
