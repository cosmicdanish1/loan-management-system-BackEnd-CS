-- Migration: Add generation tracking columns to license_keys
-- Run once against the database before using generate-license.js

-- 1. Add 'generated' value to the status enum (safe: checks before adding)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'license_status_enum'
      AND e.enumlabel = 'generated'
  ) THEN
    ALTER TYPE license_status_enum ADD VALUE 'generated';
  END IF;
END$$;

-- 2. Add new columns (IF NOT EXISTS = safe to re-run)
ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS company_name   VARCHAR(200);
ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS generated_by   VARCHAR(100);
ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS duration_months INTEGER;
