-- ES-393: signed license keys (format PWT1-...) are about 120 characters; the column held 50.
-- LicenseService also runs this on every start, so applying it by hand is optional.
ALTER TABLE license_keys ALTER COLUMN "key" TYPE VARCHAR(200);
