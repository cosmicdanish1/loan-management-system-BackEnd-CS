-- Migration: Create loan_monthly_balance table
-- Month-end snapshot of outstanding loan balances per member.
-- Used for audit, reporting, and detecting discrepancies between
-- loan_master.balance and member_balances.regularloan/emergency_loan_balance.

CREATE TABLE IF NOT EXISTS loan_monthly_balance (
    id                       SERIAL PRIMARY KEY,
    mbno                     NUMERIC       NOT NULL,
    snapshot_month           INTEGER       NOT NULL,
    snapshot_year            INTEGER       NOT NULL,
    regular_loan_balance     NUMERIC(15,2) DEFAULT 0,
    emergency_loan_balance   NUMERIC(15,2) DEFAULT 0,
    additional_loan_balance  NUMERIC(15,2) DEFAULT 0,
    snapshot_date            DATE          DEFAULT CURRENT_DATE,
    created_at               TIMESTAMP     DEFAULT NOW(),
    UNIQUE (mbno, snapshot_month, snapshot_year)
);

CREATE INDEX IF NOT EXISTS idx_lmb_mbno       ON loan_monthly_balance (mbno);
CREATE INDEX IF NOT EXISTS idx_lmb_month_year ON loan_monthly_balance (snapshot_year, snapshot_month);
