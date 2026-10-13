/**
 * ES-48: head balances computed live from the ledger.
 *
 * The `balancesheet` table was a snapshot that nothing kept up to date, so the Head screen,
 * the Balance Sheet and the year-end transfer showed stale numbers. Every reader now selects
 * from this query instead, and "Build Tree" just persists the same rows.
 *
 * One row per posting head (each head's OWN movement, no roll-up; screens add parents up):
 *  - opening_balance: stored negative for credit-normal heads (L / I), positive for A / E
 *  - debit / credit:  lifetime ledger movement (R / P legacy codes are treated as CR / DR)
 *  - closingbalance:  natural-side balance (op_bal +/- movement)
 * A head is included when it has no child heads, or when it has an opening balance or ledger
 * postings of its own (e.g. I1002 "INTT FROM MEMBER", which is now also the parent of the
 * per-loan-type interest heads). The root (M1000) and section roots (pflag R) are excluded.
 */
export const HEAD_BALANCES_SELECT_AS_ON = (paramIndex: number) =>
  HEAD_BALANCES_SELECT.replace('/*AS_ON*/', `WHERE trans_date::date <= $${paramIndex}::date`);

export const HEAD_BALANCES_SELECT = `
  SELECT
    hm.code        AS head_code,
    hm.parent_code AS parent_code,
    hm.head_name   AS head_name,
    CASE WHEN hm.code LIKE 'L%' OR hm.code LIKE 'I%'
         THEN -COALESCE(hm.op_bal, 0)
         ELSE  COALESCE(hm.op_bal, 0) END AS opening_balance,
    COALESCE(lag.total_dr, 0) AS debit,
    COALESCE(lag.total_cr, 0) AS credit,
    CASE WHEN hm.code LIKE 'L%' OR hm.code LIKE 'I%'
         THEN COALESCE(hm.op_bal, 0) + COALESCE(lag.total_cr, 0) - COALESCE(lag.total_dr, 0)
         ELSE COALESCE(hm.op_bal, 0) + COALESCE(lag.total_dr, 0) - COALESCE(lag.total_cr, 0)
         END AS closingbalance,
    CASE WHEN hm.code NOT LIKE 'L%' AND hm.code NOT LIKE 'I%'
         THEN GREATEST(0, COALESCE(hm.op_bal, 0) + COALESCE(lag.total_dr, 0) - COALESCE(lag.total_cr, 0))
         ELSE 0 END AS closingbal_db,
    CASE WHEN hm.code LIKE 'L%' OR hm.code LIKE 'I%'
         THEN GREATEST(0, COALESCE(hm.op_bal, 0) + COALESCE(lag.total_cr, 0) - COALESCE(lag.total_dr, 0))
         ELSE 0 END AS closing_cr,
    CASE WHEN hm.code LIKE 'L%' THEN 1
         WHEN hm.code LIKE 'A%' THEN 2
         WHEN hm.code LIKE 'I%' THEN 3
         WHEN hm.code LIKE 'E%' THEN 4
         ELSE 2 END AS maincd
  FROM headmaster hm
  LEFT JOIN (
    SELECT code,
      SUM(CASE WHEN UPPER(TRIM(trans_type)) IN ('DR', 'P') THEN trans_amt::numeric ELSE 0 END) AS total_dr,
      SUM(CASE WHEN UPPER(TRIM(trans_type)) IN ('CR', 'R') THEN trans_amt::numeric ELSE 0 END) AS total_cr
    FROM ledger
    /*AS_ON*/
    GROUP BY code
  ) lag ON lag.code = hm.code
  WHERE hm.code <> 'M1000'
    AND COALESCE(hm.pflag, '') <> 'R'
    AND hm.parent_code IS NOT NULL
    AND hm.parent_code NOT IN ('', '0')
    AND (
      NOT EXISTS (SELECT 1 FROM headmaster child WHERE child.parent_code = hm.code)
      OR COALESCE(hm.op_bal, 0) <> 0
      OR lag.code IS NOT NULL
    )
`;
