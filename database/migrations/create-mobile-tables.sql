-- Fibe Mobile (member app): all new tables. Idempotent, so it is safe to run more than once.
-- Existing tables are not touched. mbno columns are plain references (no foreign key to member_master)
-- so member clean-ups / re-migrations never fail because of mobile data.
-- ES-221. PRD: docs/final-documentation/mobile_app_prd, section 11.

-- One row per member who has ever started activation.
CREATE TABLE IF NOT EXISTS mobile_account (
    mbno            numeric(18,0) PRIMARY KEY,
    status          varchar(20)  NOT NULL DEFAULT 'NOT_ACTIVATED',  -- NOT_ACTIVATED, REQUEST_PENDING, ACTIVE, LOCKED, BLOCKED, DEACTIVATED
    mpin_hash       varchar(100),
    failed_attempts integer      NOT NULL DEFAULT 0,
    locked_until    timestamptz,
    activated_at    timestamptz,
    blocked_reason  varchar(300),
    blocked_by      varchar(100),
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- Trusted phones (max 2 per member, enforced by the service). Also holds the App Code secret (encrypted).
CREATE TABLE IF NOT EXISTS mobile_device (
    id                  bigserial PRIMARY KEY,
    mbno                numeric(18,0) NOT NULL,
    device_id_hash      varchar(64)   NOT NULL,
    platform            varchar(10),
    model               varchar(100),
    os_version          varchar(40),
    app_version         varchar(20),
    appcode_secret_enc  text,
    revoked             boolean       NOT NULL DEFAULT false,
    revoked_at          timestamptz,
    revoked_by          varchar(100),
    last_seen           timestamptz,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (mbno, device_id_hash)
);
CREATE INDEX IF NOT EXISTS idx_mobile_device_mbno ON mobile_device (mbno);

-- Refresh-token families (rotation and reuse detection). Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS mobile_session (
    id          bigserial PRIMARY KEY,
    mbno        numeric(18,0) NOT NULL,
    device_id   bigint        NOT NULL REFERENCES mobile_device(id) ON DELETE CASCADE,
    family_id   varchar(40)   NOT NULL,
    token_hash  varchar(64)   NOT NULL UNIQUE,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    expires_at  timestamptz   NOT NULL,
    used_at     timestamptz,
    revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mobile_session_family ON mobile_session (family_id);
CREATE INDEX IF NOT EXISTS idx_mobile_session_mbno ON mobile_session (mbno);

-- One-time activation codes issued by staff (Control Center). Only a hash is stored.
CREATE TABLE IF NOT EXISTS mobile_activation_code (
    id              bigserial PRIMARY KEY,
    mbno            numeric(18,0) NOT NULL,
    code_hash       varchar(100)  NOT NULL,
    issued_by       varchar(100)  NOT NULL,
    issued_at       timestamptz   NOT NULL DEFAULT now(),
    expires_at      timestamptz   NOT NULL,
    used_at         timestamptz,
    wrong_attempts  integer       NOT NULL DEFAULT 0,
    burned          boolean       NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_mobile_activation_code_mbno ON mobile_activation_code (mbno, issued_at DESC);

-- Activation requests sent from the app; staff verify and call back before a code is released.
CREATE TABLE IF NOT EXISTS mobile_activation_request (
    id              bigserial PRIMARY KEY,
    mbno            numeric(18,0) NOT NULL,
    answers_hash    text,                         -- hashed answers, never the raw DOB / PAN / phone digits
    match_result    jsonb,                        -- which answers matched the member record
    status          varchar(20)   NOT NULL DEFAULT 'NEW',  -- NEW, CALLED_BACK, APPROVED, REJECTED
    device_id_hash  varchar(64),
    ip              varchar(64),
    handled_by      varchar(100),
    handled_at      timestamptz,
    note            varchar(500),
    created_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mobile_activation_request_status ON mobile_activation_request (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_activation_request_mbno ON mobile_activation_request (mbno, created_at DESC);

-- SMS OTP challenges. COMING SOON (parked, ES-220): table is created now so the schema is stable.
CREATE TABLE IF NOT EXISTS mobile_otp (
    id          bigserial PRIMARY KEY,
    mbno        numeric(18,0) NOT NULL,
    phone_hash  varchar(64),
    otp_hash    varchar(100),
    purpose     varchar(20),
    attempts    integer       NOT NULL DEFAULT 0,
    expires_at  timestamptz   NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobile_push_token (
    id          bigserial PRIMARY KEY,
    mbno        numeric(18,0) NOT NULL,
    device_id   bigint        NOT NULL REFERENCES mobile_device(id) ON DELETE CASCADE,
    token       text          NOT NULL,
    platform    varchar(10),
    updated_at  timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (device_id)
);

-- Proof of consent (Terms and Privacy), with the version the member saw.
CREATE TABLE IF NOT EXISTS mobile_consent (
    id              bigserial PRIMARY KEY,
    mbno            numeric(18,0) NOT NULL,
    doc_type        varchar(20)   NOT NULL,       -- TERMS, PRIVACY
    doc_version     integer       NOT NULL,
    accepted_at     timestamptz   NOT NULL DEFAULT now(),
    device_id_hash  varchar(64),
    app_version     varchar(20),
    ip              varchar(64)
);
CREATE INDEX IF NOT EXISTS idx_mobile_consent_mbno ON mobile_consent (mbno, doc_type, accepted_at DESC);

-- Change requests, queries and certificate requests, with a message thread.
CREATE TABLE IF NOT EXISTS mobile_request (
    id          bigserial PRIMARY KEY,
    mbno        numeric(18,0) NOT NULL,
    type        varchar(40)   NOT NULL,
    status      varchar(20)   NOT NULL DEFAULT 'NEW',     -- NEW, IN_REVIEW, APPROVED, REJECTED, DONE
    payload     jsonb,
    handled_by  varchar(100),
    handled_at  timestamptz,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mobile_request_mbno ON mobile_request (mbno, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_request_status ON mobile_request (status, created_at DESC);

CREATE TABLE IF NOT EXISTS mobile_request_message (
    id           bigserial PRIMARY KEY,
    request_id   bigint       NOT NULL REFERENCES mobile_request(id) ON DELETE CASCADE,
    sender       varchar(10)  NOT NULL,                   -- MEMBER, STAFF
    sender_name  varchar(100),
    body         text         NOT NULL,
    created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mobile_request_message_req ON mobile_request_message (request_id, created_at);

CREATE TABLE IF NOT EXISTS mobile_broadcast (
    id            bigserial PRIMARY KEY,
    title         varchar(200) NOT NULL,
    body          text         NOT NULL,
    audience      jsonb        NOT NULL DEFAULT '{"type":"all"}'::jsonb,
    channel       varchar(20)  NOT NULL DEFAULT 'PUSH',
    scheduled_at  timestamptz,
    status        varchar(20)  NOT NULL DEFAULT 'DRAFT',  -- DRAFT, SCHEDULED, SENDING, SENT, CANCELLED
    sent_count    integer      NOT NULL DEFAULT 0,
    failed_count  integer      NOT NULL DEFAULT 0,
    opened_count  integer      NOT NULL DEFAULT 0,
    created_by    varchar(100),
    created_at    timestamptz  NOT NULL DEFAULT now()
);

-- Remote switches read by GET /mobile/config.
CREATE TABLE IF NOT EXISTS mobile_feature_flag (
    key          varchar(60) PRIMARY KEY,
    enabled      boolean     NOT NULL DEFAULT false,
    audience     jsonb,                                   -- optional rollout filter (wing / office), null = everyone
    description  varchar(200),
    updated_by   varchar(100),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobile_app_version (
    platform               varchar(10) PRIMARY KEY,       -- android, ios
    latest_version         varchar(20),
    min_supported_version  varchar(20),
    store_url              varchar(300),
    message                varchar(300),
    updated_by             varchar(100),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- FAQ, contacts, timings, Terms and Privacy text. A new edit = a new version row.
CREATE TABLE IF NOT EXISTS mobile_content (
    id          bigserial PRIMARY KEY,
    key         varchar(60)  NOT NULL,                    -- terms, privacy, contacts, faq
    language    varchar(10)  NOT NULL DEFAULT 'en',
    version     integer      NOT NULL DEFAULT 1,
    body        text         NOT NULL,
    published   boolean      NOT NULL DEFAULT false,
    updated_by  varchar(100),
    updated_at  timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (key, language, version)
);

-- Small key/value settings (office hours, maintenance switch).
CREATE TABLE IF NOT EXISTS mobile_setting (
    key         varchar(60) PRIMARY KEY,
    value       text        NOT NULL,
    updated_by  varchar(100),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Security and activity trail (ES-224).
CREATE TABLE IF NOT EXISTS mobile_audit_log (
    id              bigserial PRIMARY KEY,
    at              timestamptz   NOT NULL DEFAULT now(),
    mbno            numeric(18,0),
    event           varchar(60)   NOT NULL,
    result          varchar(20),
    method          varchar(10),
    endpoint        varchar(200),
    status_code     integer,
    device_id_hash  varchar(64),
    ip              varchar(64),
    request_id      varchar(64),
    app_version     varchar(20),
    platform        varchar(10),
    detail          jsonb
);
CREATE INDEX IF NOT EXISTS idx_mobile_audit_log_mbno ON mobile_audit_log (mbno, at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_audit_log_event ON mobile_audit_log (event, at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_audit_log_at ON mobile_audit_log (at DESC);

-- Seed values (never overwrite what an administrator has changed).
INSERT INTO mobile_setting (key, value) VALUES
    ('office_open',          '10:00'),
    ('office_close',         '18:00'),
    ('office_days',          '1,2,3,4,5,6'),            -- ISO weekday numbers, 1 = Monday (assumption: Monday to Saturday)
    ('maintenance_enabled',  'false'),
    ('maintenance_message',  '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO mobile_feature_flag (key, enabled, description) VALUES
    ('home',          true,  'Home summary'),
    ('accounts',      true,  'Shares, compulsory deposit and savings'),
    ('loans',         true,  'Loans, EMI schedule and repayments'),
    ('ledger',        true,  'Member ledger / passbook'),
    ('statements',    true,  'PDF statements'),
    ('notices',       true,  'Notice board'),
    ('rd',            false, 'Recurring deposits (V1.1)'),
    ('insurance',     false, 'Group insurance status (V1.1)'),
    ('requests',      false, 'Change requests and queries (V1.1)'),
    ('certificates',  false, 'Certificates (V1.1)'),
    ('surety',        false, 'Loans where the member is surety (V1.1)'),
    ('fd',            false, 'Fixed deposits: OFF until the society defines FD behaviour')
ON CONFLICT (key) DO NOTHING;

INSERT INTO mobile_app_version (platform, latest_version, min_supported_version) VALUES
    ('android', '0.1.0', '0.1.0'),
    ('ios',     '0.1.0', '0.1.0')
ON CONFLICT (platform) DO NOTHING;
