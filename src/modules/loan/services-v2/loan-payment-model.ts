/**
 * Reducing balance is the society's single loan-interest method.
 *
 * Principal and interest are posted as separate ledger components, but that
 * is an accounting representation and not a second interest-calculation
 * model. The old combined-installment value is retained only as a legacy
 * database compatibility marker while old rows are upgraded.
 */
export const LOAN_INTEREST_METHOD = 'REDUCING_BALANCE' as const;
export type LoanInterestMethod = typeof LOAN_INTEREST_METHOD;
export const DEFAULT_LOAN_INTEREST_METHOD: LoanInterestMethod = LOAN_INTEREST_METHOD;

/** @deprecated Existing migration/replay code still uses the old column marker. */
export type LoanPaymentModel = 'SEPARATE_INTEREST';

/** @deprecated Existing rows may still carry the old marker. */
export function isLoanPaymentModel(value: unknown): value is LoanPaymentModel {
  return value === 'SEPARATE_INTEREST';
}
