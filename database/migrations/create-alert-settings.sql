-- Notification switches (Settings -> Notifications). One row per key: every alert, plus 'master',
-- 'dest.telegram', 'dest.discord' and 'jira.create'. A missing row means "use the default" (on).
-- AlertSettingsService also creates/upgrades this table at boot.
CREATE TABLE IF NOT EXISTS alert_settings (
    key varchar(50) PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true,
    param numeric,
    telegram boolean NOT NULL DEFAULT true,
    discord boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by varchar(100)
);
ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS telegram boolean NOT NULL DEFAULT true;
ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS discord boolean NOT NULL DEFAULT true;
