import { MigrationInterface, QueryRunner } from 'typeorm';

// Logout User / sessions: the legacy LOGINTIME stamps every sign-in with the Day-End WORKING date (date only). Ours kept
// the computer's clock only, so a session had no working date and the close time was only "HH:MM:SS" (a session that
// crossed midnight showed a negative length). Two new columns, both nullable, so old rows and old code keep working:
//   working_date  the working date of the sign-in (date only)
//   logout_at     the real moment the session ended
// Adding a column that is not there yet never changes an existing value; running it twice does nothing.
export class AddLoginTimeWorkingDate1794787200000 implements MigrationInterface {
    name = 'AddLoginTimeWorkingDate1794787200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "logintime" ADD COLUMN IF NOT EXISTS "working_date" date`);
        await queryRunner.query(`ALTER TABLE "logintime" ADD COLUMN IF NOT EXISTS "logout_at" timestamp`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_logintime_userid" ON "logintime" ("userid")`);
    }

    public async down(): Promise<void> {
        // not reversed: dropping the columns would lose the dates already stored
    }
}
