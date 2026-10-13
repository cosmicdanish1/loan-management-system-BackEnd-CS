-- ES-57: one global head order for every report that groups rows by account head.
-- A head with no row here sorts after all ordered heads, by code, so new heads never break a report.
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS report_head_order (
    code        varchar(5) PRIMARY KEY,
    position    integer    NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_head_order_position ON report_head_order (position);

-- Initial order = head code order (the order the reports already used most often).
INSERT INTO report_head_order (code, position)
SELECT code, (ROW_NUMBER() OVER (ORDER BY code))::int
FROM headmaster
WHERE code IS NOT NULL AND TRIM(code) <> ''
ON CONFLICT (code) DO NOTHING;
