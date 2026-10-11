-- Re-agreement (loan restructure) — see docs/final-documentation/re_agreement/RE_AGREEMENT_MASTER.md
-- Idempotent: safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Header: one row per re-agreement (old case -> new case)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_reagreements (
    id                          BIGSERIAL PRIMARY KEY,
    reagreement_no              VARCHAR(20)  NOT NULL,
    mbno                        NUMERIC      NOT NULL,
    loantype                    VARCHAR(10)  NOT NULL,
    old_loancaseno              NUMERIC      NOT NULL,
    new_loancaseno              NUMERIC      NOT NULL,
    status                      VARCHAR(12)  NOT NULL DEFAULT 'APPLIED',
    old_version_no              INTEGER,
    voucher_no                  VARCHAR(50),

    application_date            DATE         NOT NULL,
    sanction_date               DATE,
    effective_date              DATE,
    first_due_month             DATE,
    slot                        SMALLINT,
    sub_slot                    VARCHAR(12),
    interest_delay_months       INTEGER,
    delay_months                INTEGER,

    old_rate                    NUMERIC(8,4),
    old_installment_count       INTEGER,
    old_monthly_principal       NUMERIC(15,2),
    old_monthly_interest        NUMERIC(15,2),
    old_monthly_installment     NUMERIC(15,2),
    installments_paid           INTEGER,

    outstanding_principal       NUMERIC(15,2) NOT NULL,
    nr_principal                NUMERIC(15,2) NOT NULL DEFAULT 0,
    nr_interest                 NUMERIC(15,2) NOT NULL DEFAULT 0,
    penalty_due                 NUMERIC(15,2) NOT NULL DEFAULT 0,
    ap_interest_carried         NUMERIC(15,2) NOT NULL DEFAULT 0,
    closure_interest_total      NUMERIC(15,2) NOT NULL DEFAULT 0,

    new_rate                    NUMERIC(8,4)  NOT NULL,
    new_installment_count       INTEGER       NOT NULL,
    new_monthly_principal       NUMERIC(15,2),
    new_monthly_interest        NUMERIC(15,2),
    new_monthly_installment     NUMERIC(15,2),

    total_rb_interest           NUMERIC(15,2),
    delay_interest              NUMERIC(15,2),
    total_interest_for_emi      NUMERIC(15,2),
    rounding_mode               VARCHAR(8),
    calc_snapshot               JSONB,

    payroll_lag_old_principal   NUMERIC(15,2),
    payroll_lag_old_interest    NUMERIC(15,2),
    payroll_lag_watch_until     DATE,

    reason                      TEXT,
    created_by                  VARCHAR(100),
    created_at                  TIMESTAMP    NOT NULL DEFAULT NOW(),
    sanctioned_by               VARCHAR(100),
    sanctioned_at               TIMESTAMP,
    passed_by                   VARCHAR(100),
    passed_at                   TIMESTAMP,
    cancelled_by                VARCHAR(100),
    cancelled_at                TIMESTAMP,
    reversed_by                 VARCHAR(100),
    reversed_at                 TIMESTAMP,
    reversal_reason             TEXT,

    CONSTRAINT ck_loan_reagreements_status
        CHECK (status IN ('APPLIED','SANCTIONED','VOUCHERED','PASSED','CANCELLED')),
    CONSTRAINT ck_loan_reagreements_positive
        CHECK (new_installment_count > 0 AND new_rate >= 0 AND outstanding_principal > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_reagreements_no
    ON loan_reagreements (reagreement_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_reagreements_new_case
    ON loan_reagreements (new_loancaseno);
-- Only one OPEN (not yet passed / cancelled) re-agreement per old case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_reagreements_open_per_case
    ON loan_reagreements (mbno, loantype, old_loancaseno)
    WHERE status IN ('APPLIED','SANCTIONED','VOUCHERED');
CREATE INDEX IF NOT EXISTS idx_loan_reagreements_member
    ON loan_reagreements (mbno, loantype, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_reagreements_old_case
    ON loan_reagreements (mbno, loantype, old_loancaseno);

-- ---------------------------------------------------------------------------
-- 2. Issued agreement documents (insert-only; a reversed issue is voided, never deleted)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_reagreement_documents (
    id                      BIGSERIAL PRIMARY KEY,
    reagreement_id          BIGINT       NOT NULL REFERENCES loan_reagreements(id),
    issue_no                INTEGER      NOT NULL DEFAULT 1,
    mbno                    NUMERIC      NOT NULL,
    old_loancaseno          NUMERIC      NOT NULL,
    new_loancaseno          NUMERIC      NOT NULL,
    agreement_text          TEXT         NOT NULL,
    agreement_json          JSONB        NOT NULL,
    pdf_bytes               BYTEA,
    png_bytes               BYTEA,
    text_sha256             CHAR(64)     NOT NULL,
    pdf_sha256              CHAR(64),
    png_sha256              CHAR(64),
    signatures_used         JSONB,
    signed_scan_bytes       BYTEA,
    signed_scan_mime        VARCHAR(50),
    signed_scan_uploaded_at TIMESTAMP,
    issued_by               VARCHAR(100),
    issued_at               TIMESTAMP    NOT NULL DEFAULT NOW(),
    voided_at               TIMESTAMP,
    void_reason             TEXT,
    CONSTRAINT uq_loan_reagreement_documents_issue UNIQUE (reagreement_id, issue_no)
);
CREATE INDEX IF NOT EXISTS idx_loan_reagreement_documents_case
    ON loan_reagreement_documents (mbno, new_loancaseno);

-- ---------------------------------------------------------------------------
-- 3. Event log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_reagreement_log (
    id              BIGSERIAL PRIMARY KEY,
    reagreement_id  BIGINT       NOT NULL REFERENCES loan_reagreements(id),
    event           VARCHAR(30)  NOT NULL,
    old_status      VARCHAR(12),
    new_status      VARCHAR(12),
    actor           VARCHAR(100),
    at              TIMESTAMP    NOT NULL DEFAULT NOW(),
    request_id      VARCHAR(64),
    details         JSONB,
    ip              VARCHAR(64),
    remarks         TEXT
);
CREATE INDEX IF NOT EXISTS idx_loan_reagreement_log_reagreement
    ON loan_reagreement_log (reagreement_id, at);

-- ---------------------------------------------------------------------------
-- 4. Changes to existing tables
-- ---------------------------------------------------------------------------
ALTER TABLE loan_pending
    ADD COLUMN IF NOT EXISTS application_kind VARCHAR(12) NOT NULL DEFAULT 'NEW';
ALTER TABLE loan_pending
    ADD COLUMN IF NOT EXISTS reagreement_id BIGINT;

ALTER TABLE loan_schedule_versions
    ADD COLUMN IF NOT EXISTS reagreement_id BIGINT;
ALTER TABLE loan_schedule_versions
    ADD COLUMN IF NOT EXISTS carried_interest NUMERIC(15,2) NOT NULL DEFAULT 0;
