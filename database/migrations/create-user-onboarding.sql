-- ES-147: first-login onboarding state. One row per user; global default lives in system_settings ('onboarding.mode').
CREATE TABLE IF NOT EXISTS user_onboarding (
    user_id integer PRIMARY KEY,
    mode_override varchar(10) NOT NULL DEFAULT 'default',
    completed_at timestamptz,
    last_seen_version varchar(50),
    last_step varchar(40),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_user_onboarding_mode CHECK (mode_override IN ('default','first','always','never'))
);
