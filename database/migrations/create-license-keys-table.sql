-- License Keys Table
-- Run this once to create the license management table

CREATE TYPE license_status_enum AS ENUM ('pending', 'active', 'expired', 'revoked');

CREATE TABLE IF NOT EXISTS license_keys (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) NOT NULL UNIQUE,
  customer_name VARCHAR(100),
  status license_status_enum NOT NULL DEFAULT 'pending',
  activated_at TIMESTAMP,
  expires_at TIMESTAMP,
  grace_ends_at TIMESTAMP,
  machine_id VARCHAR(255),
  notes VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_license_keys_status ON license_keys(status);
CREATE INDEX idx_license_keys_key ON license_keys(key);

COMMENT ON TABLE license_keys IS 'Software license activation keys';
COMMENT ON COLUMN license_keys.expires_at IS 'License expires after 1 year from activation';
COMMENT ON COLUMN license_keys.grace_ends_at IS 'Grace period ends 30 days after expiry - software locks after this';
