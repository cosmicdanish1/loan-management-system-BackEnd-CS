-- ES-151: who accepted which version of the Terms & Conditions, and when.
-- The text and current version live in system_settings ('terms.version', 'terms.text').
CREATE TABLE IF NOT EXISTS terms_acceptances (
    id SERIAL PRIMARY KEY,
    user_id integer NOT NULL,
    username varchar(100),
    version varchar(30) NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_terms_user_version UNIQUE (user_id, version)
);
CREATE INDEX IF NOT EXISTS idx_terms_acceptances_version ON terms_acceptances (version);
