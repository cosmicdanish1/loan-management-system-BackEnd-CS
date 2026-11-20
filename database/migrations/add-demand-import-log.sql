-- ES-588: one record per row of every Import Demand List save (saved or skipped, with the reason), so a skipped
-- row is never just a count and the file's H.O.NO. / PS.NO. / NAME are kept as given. The backend also creates this
-- table at start (DemandImportService.onModuleInit); this file is the same statement for manual runs.
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS demand_import_log (
    id bigserial PRIMARY KEY,
    batch_id uuid NOT NULL,
    file_name text,
    row_no integer,
    demand_month integer NOT NULL,
    demand_year integer NOT NULL,
    branch text,
    member_no_given text,
    hono text,
    ps_no text,
    name_in_file text,
    member_no text,
    match_method text,
    result text NOT NULL,
    reason text,
    warnings text,
    saved_by text,
    saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demand_import_log_period ON demand_import_log (demand_year, demand_month, member_no);
CREATE INDEX IF NOT EXISTS idx_demand_import_log_batch ON demand_import_log (batch_id);
