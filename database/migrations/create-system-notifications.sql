-- ES-101: Notification Centre. System notifications are detected by NotificationCentreService.sync()
-- and kept here with a per-user read state. Same DDL as src/migrations/1791244800000-CreateSystemNotifications.ts.
CREATE TABLE IF NOT EXISTS system_notifications (
    id           SERIAL PRIMARY KEY,
    kind         varchar(40)  NOT NULL,           -- MEMBER_READY_INACTIVE | MEMBER_RETIRING_SOON | INSURANCE_DUE | NEGATIVE_RD | MESSAGES_FAILED | MESSAGES_PENDING | DAYEND_PENDING
    severity     varchar(10)  NOT NULL DEFAULT 'info',   -- info | warning | error
    title        varchar(200) NOT NULL,
    body         text,
    mbno         numeric,
    member_name  varchar(200),
    action_path  varchar(120),
    action_label varchar(40),
    dedupe_key   varchar(120) NOT NULL UNIQUE,    -- one row per real-world condition, so a re-check never duplicates it
    status       varchar(10)  NOT NULL DEFAULT 'OPEN',   -- OPEN | RESOLVED (the condition no longer holds)
    created_at   timestamp    NOT NULL DEFAULT now(),
    updated_at   timestamp    NOT NULL DEFAULT now(),
    resolved_at  timestamp
);
CREATE INDEX IF NOT EXISTS idx_system_notifications_status_kind ON system_notifications (status, kind);
CREATE INDEX IF NOT EXISTS idx_system_notifications_mbno ON system_notifications (mbno);

CREATE TABLE IF NOT EXISTS system_notification_reads (
    notification_id integer     NOT NULL REFERENCES system_notifications(id) ON DELETE CASCADE,
    username        varchar(50) NOT NULL,
    read_at         timestamp   NOT NULL DEFAULT now(),
    PRIMARY KEY (notification_id, username)
);
