-- Versioned principal schedule snapshots. A consolidation starts a new
-- schedule without rewriting the older loan/repayment history.
CREATE TABLE IF NOT EXISTS loan_schedule_versions (
    id                  BIGSERIAL PRIMARY KEY,
    mbno                NUMERIC NOT NULL,
    loantype            VARCHAR(10) NOT NULL,
    loancaseno          VARCHAR(20) NOT NULL,
    version_no          INTEGER NOT NULL,
    source              VARCHAR(24) NOT NULL,
    effective_date      DATE NOT NULL,
    first_due_month     DATE NOT NULL,
    opening_principal   NUMERIC(15,2) NOT NULL,
    monthly_principal   NUMERIC(15,2) NOT NULL,
    installment_count   INTEGER NOT NULL,
    monthly_installment NUMERIC(15,2) NOT NULL,
    annual_rate         NUMERIC(8,4) NOT NULL DEFAULT 0,
    delay_months        INTEGER NOT NULL DEFAULT 0,
    source_case_no      VARCHAR(20),
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_loan_schedule_versions_case_version
        UNIQUE (mbno, loantype, loancaseno, version_no),
    CONSTRAINT ck_loan_schedule_versions_positive
        CHECK (opening_principal >= 0 AND monthly_principal > 0 AND installment_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_loan_schedule_versions_effective
    ON loan_schedule_versions (mbno, loantype, loancaseno, effective_date DESC, version_no DESC);
