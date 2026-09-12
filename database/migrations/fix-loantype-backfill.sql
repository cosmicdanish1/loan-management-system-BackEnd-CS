-- ============================================================
-- Migration: Fix loantype backfill across all loan tables
-- Issue: loantype was not populated during legacy MS SQL → PostgreSQL migration
-- Date: 2026-04-27
-- ============================================================

-- STEP 1: Fix loan_masterhistory column type (it's numeric, should be varchar)
-- First check if it needs fixing
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'loan_masterhistory'
      AND column_name = 'loantype'
      AND data_type = 'numeric'
  ) THEN
    ALTER TABLE loan_masterhistory ALTER COLUMN loantype TYPE varchar(3) USING NULL;
    RAISE NOTICE 'Fixed loan_masterhistory.loantype column type: numeric → varchar(3)';
  ELSE
    RAISE NOTICE 'loan_masterhistory.loantype already correct type';
  END IF;
END $$;

-- STEP 2: Fix loan_pending_aln — all rows are ALN by definition
UPDATE loan_pending_aln
SET loantype = 'ALN'
WHERE loantype IS NULL OR loantype = '';

-- STEP 3: Fix loan_pending_rln — all rows are RLN by definition
UPDATE loan_pending_rln
SET loantype = 'RLN'
WHERE loantype IS NULL OR loantype = '';

-- STEP 4: Fix loan_pending — use loan_pending_aln/rln to identify type by mbno+loancaseno
-- For rows that exist in loan_pending_aln archive
UPDATE loan_pending lp
SET loantype = 'ALN'
WHERE (lp.loantype IS NULL OR lp.loantype = '')
  AND EXISTS (
    SELECT 1 FROM loan_pending_aln aln
    WHERE aln.mbno = lp.mbno
  );

-- For rows that exist in loan_pending_rln archive
UPDATE loan_pending lp
SET loantype = 'RLN'
WHERE (lp.loantype IS NULL OR lp.loantype = '')
  AND EXISTS (
    SELECT 1 FROM loan_pending_rln rln
    WHERE rln.mbno = lp.mbno
  );

-- Remaining loan_pending rows with no match — default to ALN (most common type in legacy)
-- These are the bulk of migrated data
UPDATE loan_pending
SET loantype = 'ALN'
WHERE loantype IS NULL OR loantype = '';

-- STEP 5: Fix loan_masterhistory using loan_pending (now fixed)
UPDATE loan_masterhistory lmh
SET loantype = lp.loantype
FROM loan_pending lp
WHERE lmh.mbno = lp.mbno
  AND lmh.loancaseno = lp.loancaseno
  AND (lmh.loantype IS NULL OR lmh.loantype = '');

-- Fallback for loan_masterhistory rows not in loan_pending
UPDATE loan_masterhistory
SET loantype = 'ALN'
WHERE loantype IS NULL OR loantype = '';

-- STEP 6: Fix loan_master using loan_pending (now fixed)
UPDATE loan_master lm
SET loantype = lp.loantype
FROM loan_pending lp
WHERE lm.mbno = lp.mbno
  AND lm.loancaseno = lp.loancaseno
  AND (lm.loantype IS NULL OR lm.loantype = '');

-- Fallback for loan_master rows not in loan_pending
UPDATE loan_master
SET loantype = 'ALN'
WHERE loantype IS NULL OR loantype = '';

-- ============================================================
-- VERIFICATION QUERIES (run after migration to confirm)
-- ============================================================
SELECT 'loan_master' as tbl, loantype, COUNT(*) FROM loan_master GROUP BY loantype ORDER BY 2;
SELECT 'loan_pending' as tbl, loantype, COUNT(*) FROM loan_pending GROUP BY loantype ORDER BY 2;
SELECT 'loan_pending_aln' as tbl, loantype, COUNT(*) FROM loan_pending_aln GROUP BY loantype ORDER BY 2;
SELECT 'loan_pending_rln' as tbl, loantype, COUNT(*) FROM loan_pending_rln GROUP BY loantype ORDER BY 2;
SELECT 'loan_masterhistory' as tbl, loantype::text, COUNT(*) FROM loan_masterhistory GROUP BY loantype ORDER BY 2;
