-- App Code (ES-385): per-phone state for wrong-code lockout and replay protection.
ALTER TABLE mobile_device ADD COLUMN IF NOT EXISTS appcode_wrong integer NOT NULL DEFAULT 0;
ALTER TABLE mobile_device ADD COLUMN IF NOT EXISTS appcode_locked_until timestamptz;
ALTER TABLE mobile_device ADD COLUMN IF NOT EXISTS appcode_last_step bigint;
