-- Migration: Create loan_repayment_ledger table
-- Tracks every individual loan repayment posted by a member.
-- Replaces the gap where payments had no dedicated audit trail.

CREATE TABLE IF NOT EXISTS loan_repayment_ledger (
    id              SERIAL PRIMARY KEY,
    mbno            NUMERIC       NOT NULL,
    loancaseno      VARCHAR(20)   NOT NULL,
    loantype        VARCHAR(10),
    payment_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
    payment_month   INTEGER       NOT NULL,
    payment_year    INTEGER       NOT NULL,
    payment_amount  NUMERIC(15,2) NOT NULL,
    receipt_no      VARCHAR(30),
    narration       TEXT,
    posted_by       VARCHAR(50),
    created_at      TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lrl_mbno         ON loan_repayment_ledger (mbno);
CREATE INDEX IF NOT EXISTS idx_lrl_loancaseno   ON loan_repayment_ledger (loancaseno);
CREATE INDEX IF NOT EXISTS idx_lrl_month_year   ON loan_repayment_ledger (payment_year, payment_month);
