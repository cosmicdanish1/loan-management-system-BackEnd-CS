-- "Raise a Query" desk. Same DDL as src/migrations/1790812800000-CreateSupportQueries.ts.
CREATE TABLE IF NOT EXISTS support_queries (
    id SERIAL PRIMARY KEY,
    subject varchar(200) NOT NULL,
    description text NOT NULL,
    module varchar(80),
    query_type varchar(20) NOT NULL DEFAULT 'OTHER',
    priority varchar(10) NOT NULL DEFAULT 'MEDIUM',
    status varchar(20) NOT NULL DEFAULT 'OPEN',
    reporter_userid varchar(50),
    reporter_username varchar(100),
    reporter_role varchar(50),
    route varchar(300),
    app_version varchar(50),
    client_info text,
    screenshot_path varchar(300),
    jira_key varchar(30),
    jira_status varchar(15) NOT NULL DEFAULT 'PENDING',
    jira_attempts integer NOT NULL DEFAULT 0,
    jira_error text,
    telegram_status varchar(15) NOT NULL DEFAULT 'PENDING',
    telegram_attempts integer NOT NULL DEFAULT 0,
    telegram_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_queries_reporter ON support_queries (reporter_username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_queries_delivery ON support_queries (jira_status, telegram_status);
