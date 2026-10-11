/**
 * Loan-interest income heads (ES-46).
 *
 * I1002 "INTT FROM MEMBER" is the parent/total interest head. Postings made
 * from ES-46 onward go to a child head per loan type so the General Ledger and
 * P&L can show Regular vs Emergency interest separately. History posted before
 * that stays on I1002 and is intentionally not backfilled.
 */
export const LOAN_INTEREST_PARENT_HEAD = 'I1002';

const LOAN_INTEREST_HEAD_BY_TYPE: Record<string, string> = {
    RLN: 'I1013', // INTT FROM MEMBER - REGULAR LOAN
    ALN: 'I1014', // INTT FROM MEMBER - EMERGENCY LOAN
};

/** Interest income head for a loan type; loan types without a dedicated head fall back to the I1002 parent. */
export function interestHeadForLoanType(loanType?: string | null): string {
    return LOAN_INTEREST_HEAD_BY_TYPE[String(loanType || '').trim().toUpperCase()] ?? LOAN_INTEREST_PARENT_HEAD;
}

/** I1002 plus every per-loan-type child, for reports that total loan interest across all of them. */
export const ALL_LOAN_INTEREST_HEADS: string[] = [
    LOAN_INTEREST_PARENT_HEAD,
    ...Object.values(LOAN_INTEREST_HEAD_BY_TYPE),
];
