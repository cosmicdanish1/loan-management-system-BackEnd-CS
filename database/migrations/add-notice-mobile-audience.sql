-- Dashboard notices: choose which notices go to the Fibe Mobile app and to whom (ES-231).
-- show_on_mobile = false keeps a notice staff-only (default, so nothing existing is ever sent to phones).
-- audience_wing / audience_office both NULL = every member; otherwise only members of that wing (and office).
ALTER TABLE dashboard_notices ADD COLUMN IF NOT EXISTS show_on_mobile boolean NOT NULL DEFAULT false;
ALTER TABLE dashboard_notices ADD COLUMN IF NOT EXISTS audience_wing varchar(5);
ALTER TABLE dashboard_notices ADD COLUMN IF NOT EXISTS audience_office integer;
CREATE INDEX IF NOT EXISTS idx_dashboard_notices_mobile ON dashboard_notices (show_on_mobile, sort_order);
