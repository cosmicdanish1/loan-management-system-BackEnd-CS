/**
 * OPENING BALANCE OF A MEMBER'S LOAN ACCOUNT (one rule, used everywhere).
 *
 * The legacy system re-creates every open loan as a new case at each financial year-end and stamps the balance carried forward on it as
 * `loan_master.openbalance`. One debt therefore shows up as several cases with an openbalance on them (the same figure repeated when nothing
 * was paid in the year, a smaller figure when it was paid down). Adding them counts the same debt more than once; only the newest carried
 * case is the real balance when the ledger begins.
 *
 * Rule, per loan type (regular = RLN, emergency = ALN/ELN):
 *   1. look at the cases of that loan type that carry an openbalance;
 *   2. ignore cases dated on/after the first ledger entry of that loan head (a loan created later, e.g. by a consolidation or in this app,
 *      is posted to the ledger as a debit and is not an opening balance);
 *   3. take the latest-dated of the remaining cases (if several share that date, they are separate loans: add them);
 *   4. that openbalance is the opening; no qualifying case = 0.
 * Checked on the migrated data: of 459 loan accounts where this differs from adding all cases, 283 close at exactly 0 (loan repaid) with
 * this rule against 1 when added.
 *
 * Returns a SQL scalar expression. `mbno` and `isRegular` are SQL expressions (e.g. '$1::numeric', '$2' or 'true'); `isRegular` must be
 * boolean-typed and true for the regular-loan head (A1002), false for the emergency head (A1047).
 * The same logic is copied (plain SQL) into backend/scripts/legacy-migration/_pattern_scan.js and _ledger_audit.js — keep them in step.
 */
export const loanHeadOpeningSql = (mbno: string, isRegular: string): string => `(
  SELECT COALESCE(SUM(lm.openbalance), 0) FROM loan_master lm
   WHERE lm.mbno = ${mbno} AND ((lm.loantype = 'RLN') = ${isRegular}) AND lm.openbalance > 0
     AND lm.payment_date = (
       SELECT MAX(x.payment_date) FROM loan_master x
        WHERE x.mbno = lm.mbno AND ((x.loantype = 'RLN') = ${isRegular}) AND x.openbalance > 0
          AND x.payment_date < COALESCE(
                (SELECT MIN(l.trans_date) FROM ledger l WHERE l.mbno = lm.mbno AND l.code = CASE WHEN ${isRegular} THEN 'A1002' ELSE 'A1047' END),
                '9999-12-31'))
)`;
