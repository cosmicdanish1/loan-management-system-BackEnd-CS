-- ES-99: member_master.date_of_retirement is the single source of truth for a member's
-- retirement date. The old `dor` column is kept (old code / legacy scripts still write it)
-- but is now forced to mirror date_of_retirement by a trigger.
--
-- Rules agreed with the user (2026-10-12):
--   * date_of_retirement always wins when the two differ.
--   * dor-only values (date_of_retirement empty) are copied across.
--   * `supanuationdate` is a different thing (withdrawal date) and is not touched here.

-- 1. Keep the old dor values that are about to be replaced, so nothing is lost.
CREATE TABLE IF NOT EXISTS member_dor_backup_es99 (
    mbno        numeric,
    dor_old     timestamp,
    dor_retire  timestamp,
    backed_up_at timestamp NOT NULL DEFAULT now()
);

INSERT INTO member_dor_backup_es99 (mbno, dor_old, dor_retire)
SELECT mbno, dor, date_of_retirement
  FROM member_master
 WHERE dor IS NOT NULL
   AND dor IS DISTINCT FROM date_of_retirement
   AND NOT EXISTS (SELECT 1 FROM member_dor_backup_es99 b WHERE b.mbno = member_master.mbno);

-- 2. One-time merge.
UPDATE member_master SET date_of_retirement = dor
 WHERE date_of_retirement IS NULL AND dor IS NOT NULL;

UPDATE member_master SET dor = date_of_retirement
 WHERE date_of_retirement IS NOT NULL AND dor IS DISTINCT FROM date_of_retirement;

-- 3. Keep them in sync for every future writer.
--    A write that changes only `dor` (old code) is copied into date_of_retirement;
--    any other write makes `dor` mirror date_of_retirement.
CREATE OR REPLACE FUNCTION member_master_sync_retirement() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.date_of_retirement IS NULL THEN
            NEW.date_of_retirement := NEW.dor;
        END IF;
        NEW.dor := NEW.date_of_retirement;
    ELSE
        IF NEW.dor IS DISTINCT FROM OLD.dor
           AND NEW.date_of_retirement IS NOT DISTINCT FROM OLD.date_of_retirement THEN
            NEW.date_of_retirement := NEW.dor;
        ELSE
            NEW.dor := NEW.date_of_retirement;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_member_master_sync_retirement ON member_master;
CREATE TRIGGER trg_member_master_sync_retirement
    BEFORE INSERT OR UPDATE ON member_master
    FOR EACH ROW EXECUTE FUNCTION member_master_sync_retirement();
