import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-652: One Personal Number = One Member. member_master.pfno holds the Personal Number (Sr.No / EPF / P.No).
// The migrated legacy data already shares 85 numbers between 173 members, so a plain unique index cannot be created
// (and those members must not be changed behind the owner's back). This trigger gives the same database-level
// guarantee for every NEW number: it runs only when a row is inserted or its Personal Number is changed, takes a lock
// per number (so two simultaneous saves cannot both pass) and refuses a number another member already holds.
// A bulk load (legacy migration) can switch it off for its own session: SET app.skip_pfno_check = 'on'.
// Running it twice does nothing new (CREATE OR REPLACE / DROP IF EXISTS).
export class MemberPersonalNumberUnique1794873600000 implements MigrationInterface {
    name = 'MemberPersonalNumberUnique1794873600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION member_master_pfno_unique() RETURNS trigger AS $$
            BEGIN
                IF coalesce(current_setting('app.skip_pfno_check', true), '') = 'on' THEN RETURN NEW; END IF;
                IF NEW.pfno IS NOT NULL AND btrim(NEW.pfno) <> ''
                   AND (TG_OP = 'INSERT' OR btrim(coalesce(OLD.pfno, '')) IS DISTINCT FROM btrim(NEW.pfno)) THEN
                    PERFORM pg_advisory_xact_lock(hashtext('member_pfno:' || btrim(NEW.pfno)));
                    IF EXISTS (SELECT 1 FROM member_master m WHERE btrim(m.pfno) = btrim(NEW.pfno) AND m.mbno <> NEW.mbno) THEN
                        RAISE EXCEPTION 'PERSONAL_NUMBER_EXISTS' USING ERRCODE = '23505';
                    END IF;
                END IF;
                RETURN NEW;
            END $$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS trg_member_master_pfno_unique ON member_master`);
        await queryRunner.query(`
            CREATE TRIGGER trg_member_master_pfno_unique
            BEFORE INSERT OR UPDATE OF pfno ON member_master
            FOR EACH ROW EXECUTE FUNCTION member_master_pfno_unique()
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_member_master_pfno ON member_master (btrim(pfno))`);
    }

    public async down(): Promise<void> {
        // not reversed: removing the rule would let duplicate Personal Numbers back in
    }
}
