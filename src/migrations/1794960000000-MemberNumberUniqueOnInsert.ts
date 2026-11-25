import { MigrationInterface, QueryRunner } from 'typeorm';

// member_master has no unique key on the member number, and the migrated legacy data already holds 4 numbers twice
// (the legacy itself gave a new member the number 990042303, which another member already had). A plain primary key
// cannot be created while those rows exist, so this trigger refuses a NEW row whose number is already held by a member.
// It runs on INSERT only, so the existing rows stay editable. A bulk load can switch it off for its own session:
// SET app.skip_pfno_check = 'on' (the same switch as the Personal Number rule). Running it twice does nothing new.
export class MemberNumberUniqueOnInsert1794960000000 implements MigrationInterface {
    name = 'MemberNumberUniqueOnInsert1794960000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION member_master_mbno_unique() RETURNS trigger AS $$
            BEGIN
                IF coalesce(current_setting('app.skip_pfno_check', true), '') = 'on' THEN RETURN NEW; END IF;
                PERFORM pg_advisory_xact_lock(hashtext('member_mbno:' || NEW.mbno::text));
                IF EXISTS (SELECT 1 FROM member_master m WHERE m.mbno = NEW.mbno) THEN
                    RAISE EXCEPTION 'MEMBER_NUMBER_EXISTS' USING ERRCODE = '23505';
                END IF;
                RETURN NEW;
            END $$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS trg_member_master_mbno_unique ON member_master`);
        await queryRunner.query(`
            CREATE TRIGGER trg_member_master_mbno_unique
            BEFORE INSERT ON member_master
            FOR EACH ROW EXECUTE FUNCTION member_master_mbno_unique()
        `);
    }

    public async down(): Promise<void> {
        // not reversed: removing the rule would let duplicate member numbers back in
    }
}
