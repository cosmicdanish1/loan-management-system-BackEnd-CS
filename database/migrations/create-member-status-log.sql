-- ES-100: audit trail for manually marking a member inactive / re-activating them.
-- Same DDL as src/migrations/1791072000000-CreateMemberStatusLog.ts.
CREATE TABLE IF NOT EXISTS member_status_log (
    id              SERIAL PRIMARY KEY,
    mbno            numeric       NOT NULL,
    action          varchar(20)   NOT NULL,          -- MARK_INACTIVE | REACTIVATE
    reason          text,
    retirement_date date,
    rd_balance      numeric(14,2),
    loan_balance    numeric(14,2),
    forced          boolean       NOT NULL DEFAULT false,
    done_by         varchar(50),
    done_at         timestamp     NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_member_status_log_mbno ON member_status_log (mbno, done_at DESC);
