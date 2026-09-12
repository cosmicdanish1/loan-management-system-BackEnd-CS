/**
 * RD (Recurring Deposit) business-rule defaults — every numeric/policy value
 * in the user's spec that must be configurable from "Modify Business Rules"
 * rather than hardcoded, read via the same system_configs pattern already
 * proven in loan-eligibility.service.ts (RegularLoanRules).
 */
export interface RdRules {
    /** Minimum monthly RD amount a member may select. Configurable — was
     *  described as a flat ₹200 floor, but the user asked for it to be a
     *  business rule, not a hardcoded constant. */
    RULE_RD_MIN_MONTHLY_AMOUNT: number;

    /** Annual opening-balance interest rate (%). Stored per-financial-year on
     *  rd_financial_year_summary at closing time, so a later rate change
     *  never alters an already-closed year's figures. */
    RULE_RD_OPENING_BALANCE_RATE: number;

    /** Minimum balance a member must retain after any withdrawal. */
    RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL: number;

    // ── Payment-pattern eligibility thresholds ──────────────────────────
    // These drive the one general rule-evaluation engine (not six hardcoded
    // pattern-matchers) that classifies a member's 12-month installment
    // history as auto-eligible for full annual interest or not.

    /** Minimum consecutive on-time installments required somewhere in the
     *  year for the record to be considered "regular". */
    RULE_RD_MIN_CONSECUTIVE_INSTALLMENTS: number;

    /** Longest single run of consecutively missed months still tolerated. */
    RULE_RD_MAX_PAYMENT_GAP_MONTHS: number;

    /** Total missed installments (across the whole year) still tolerated,
     *  even if later cleared as arrears. */
    RULE_RD_MAX_MISSED_INSTALLMENTS: number;

    /** After a gap is cleared, how many further consecutive regular payments
     *  are required before the member is "back to regular". */
    RULE_RD_MIN_REGULAR_AFTER_RECOVERY: number;

    /** Whether a gap at the START of the financial year (Pattern C) can be
     *  recovered from at all. */
    RULE_RD_ALLOW_INITIAL_MISS_RECOVERY: boolean;

    /** Whether a gap LATER in the financial year (Pattern D) can be
     *  recovered from at all. */
    RULE_RD_ALLOW_LATER_MISS_RECOVERY: boolean;

    /** Maximum number of months allowed to fully clear an arrear before it
     *  no longer counts as "recovered" for eligibility purposes. */
    RULE_RD_MAX_ARREARS_CLEARANCE_MONTHS: number;

    /** Whether more than one separate gap in the same year is still
     *  eligible for automatic full interest (Pattern F territory otherwise). */
    RULE_RD_ALLOW_MULTIPLE_GAPS: boolean;
}

export const RD_RULE_DEFAULTS: RdRules = {
    RULE_RD_MIN_MONTHLY_AMOUNT: 200,
    RULE_RD_OPENING_BALANCE_RATE: 7,
    RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL: 1000,
    RULE_RD_MIN_CONSECUTIVE_INSTALLMENTS: 4,
    RULE_RD_MAX_PAYMENT_GAP_MONTHS: 3,
    RULE_RD_MAX_MISSED_INSTALLMENTS: 3,
    RULE_RD_MIN_REGULAR_AFTER_RECOVERY: 3,
    RULE_RD_ALLOW_INITIAL_MISS_RECOVERY: true,
    RULE_RD_ALLOW_LATER_MISS_RECOVERY: true,
    RULE_RD_MAX_ARREARS_CLEARANCE_MONTHS: 3,
    RULE_RD_ALLOW_MULTIPLE_GAPS: false,
};

export const RD_RULE_KEYS = Object.keys(RD_RULE_DEFAULTS) as Array<keyof RdRules>;

export const RD_BOOLEAN_RULE_KEYS: string[] = RD_RULE_KEYS.filter(
    (k) => typeof RD_RULE_DEFAULTS[k] === 'boolean',
);

export const RD_NUMERIC_RULE_KEYS: string[] = RD_RULE_KEYS.filter(
    (k) => typeof RD_RULE_DEFAULTS[k] === 'number',
);
