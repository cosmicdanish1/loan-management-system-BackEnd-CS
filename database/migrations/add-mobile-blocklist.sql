-- Mobile Control Center > Security and audit (ES-243): block a phone (by device hash) or an internet address from the member app.
-- Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS mobile_blocklist (
    id             bigserial PRIMARY KEY,
    kind           varchar(10)  NOT NULL CHECK (kind IN ('IP', 'DEVICE')),
    value          varchar(100) NOT NULL,                 -- IP address, or the SHA-256 device hash (never the raw device id)
    reason         varchar(300),
    blocked_by     varchar(100),
    blocked_at     timestamptz  NOT NULL DEFAULT now(),
    unblocked_at   timestamptz,
    unblocked_by   varchar(100)
);
-- One active block per value.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_blocklist_active ON mobile_blocklist (kind, value) WHERE unblocked_at IS NULL;
