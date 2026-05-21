-- ============================================================
-- Production-Ready Schema Fixes
-- Run once; all statements are idempotent (IF NOT EXISTS).
-- ============================================================

-- ---------------------------------------------------------------
-- FIX 4.1: Add missing columns to member_master
-- Required by saveMemberMaster UPDATE query (member-crud.service.ts)
-- ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='member_master' AND column_name='aadharno') THEN
    ALTER TABLE member_master ADD COLUMN aadharno VARCHAR(20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='member_master' AND column_name='phoneno') THEN
    ALTER TABLE member_master ADD COLUMN phoneno VARCHAR(15);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='member_master' AND column_name='pan_no') THEN
    ALTER TABLE member_master ADD COLUMN pan_no VARCHAR(15);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='member_master' AND column_name='frs_no') THEN
    ALTER TABLE member_master ADD COLUMN frs_no VARCHAR(20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='member_master' AND column_name='fathers_name') THEN
    ALTER TABLE member_master ADD COLUMN fathers_name VARCHAR(100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='member_master' AND column_name='branchmsno') THEN
    ALTER TABLE member_master ADD COLUMN branchmsno INTEGER;
  END IF;
END $$;

-- ---------------------------------------------------------------
-- FIX 4.2: Create certificate and passbook template tables
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificate_templates (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  type        VARCHAR(20)  NOT NULL DEFAULT 'SHARE', -- SHARE | FD | MEMBERSHIP
  html_body   TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certificate_fields (
  id              SERIAL PRIMARY KEY,
  template_id     INTEGER      NOT NULL REFERENCES certificate_templates(id) ON DELETE CASCADE,
  field_name      VARCHAR(50)  NOT NULL,
  field_label     VARCHAR(100),
  field_type      VARCHAR(20)  NOT NULL DEFAULT 'text', -- text | date | number | image
  placeholder     VARCHAR(100),
  sort_order      SMALLINT     NOT NULL DEFAULT 0,
  is_required     BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS passbook_templates (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  account_type VARCHAR(10) NOT NULL DEFAULT 'SB', -- SB | FD | RD | LN
  header_html TEXT,
  footer_html TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- FIX 4.3: Composite index on ledger(code, trans_date)
-- Speeds up detail ledger and cash-book opening balance queries.
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ledger_code_transdate
  ON ledger (code, trans_date);

-- Secondary index for member-account lookups used by member ledger reports
CREATE INDEX IF NOT EXISTS idx_ledger_mbno_transdate
  ON ledger (mbno, trans_date);
