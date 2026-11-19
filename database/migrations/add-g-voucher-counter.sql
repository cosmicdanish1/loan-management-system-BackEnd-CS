-- ES-503: separate counter for demand (Updation Ledger) posting voucher numbers (G#####). Safe to run more than once.
ALTER TABLE voucher_master ADD COLUMN IF NOT EXISTS g_vchr_no varchar(20) NOT NULL DEFAULT 'G00000';
