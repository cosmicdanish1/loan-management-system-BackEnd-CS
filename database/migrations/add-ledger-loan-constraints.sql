-- ES-452: the ledger, the repayment ledger and the loan master had no database rules at all, so a bad amount or a
-- repeated loan could be saved without anything noticing. This adds the rules that are safe on every install.
-- Safe to run more than once. Existing rows are never changed or removed.
--
-- 1. ledger.trans_amt cannot be negative. Zero stays allowed (the legacy has zero-amount lines). Added NOT VALID:
--    every new and changed row is checked; rows that are already there (old test rows) are left alone, so this
--    cannot fail on an existing database.
-- 2. loan_repayment_ledger.payment_amount cannot be negative (same NOT VALID reason).
-- 3. A loan is unique by case number + member + loan type. NOT by case number alone: the legacy repeats case numbers
--    across members and types (case 1667 belongs to three members). Created only when there are no repeats now;
--    otherwise it is skipped with a notice and can be created after the repeats are cleaned.
--
-- Not included on purpose: a unique ledgerid. Several posting paths (financial year, SB account, dividend, group
-- insurance, repayment/early-closure hold, RD/CD receipt) still take MAX(ledgerid)+1 without the shared lock, so a
-- unique index would turn two simultaneous postings into a failed posting. Add it after those paths use the lock.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ledger_trans_amt_not_negative' AND conrelid = 'ledger'::regclass) THEN
        ALTER TABLE ledger ADD CONSTRAINT ck_ledger_trans_amt_not_negative CHECK (trans_amt >= 0) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_loan_repayment_ledger_payment_not_negative' AND conrelid = 'loan_repayment_ledger'::regclass) THEN
        ALTER TABLE loan_repayment_ledger ADD CONSTRAINT ck_loan_repayment_ledger_payment_not_negative CHECK (payment_amount >= 0) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ux_loan_master_case_member_type') THEN
        IF EXISTS (SELECT 1 FROM loan_master GROUP BY loancaseno, mbno, loantype HAVING count(*) > 1) THEN
            RAISE NOTICE 'ES-452: ux_loan_master_case_member_type not created, loan_master has repeated case + member + type';
        ELSE
            CREATE UNIQUE INDEX ux_loan_master_case_member_type ON loan_master (loancaseno, mbno, loantype);
        END IF;
    END IF;
END $$;
