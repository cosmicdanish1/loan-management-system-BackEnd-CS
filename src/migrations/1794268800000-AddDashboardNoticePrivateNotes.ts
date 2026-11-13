import { MigrationInterface, QueryRunner } from 'typeorm';

// Personal sticky notes on the dashboard: a notice can be private to its author (and later published),
// an administrator can mark a notice important, and a note can carry a colour.
// Safe to run more than once. NoticeService also adds these columns at start-up, so an install whose
// migrations table is out of step still gets them.
export class AddDashboardNoticePrivateNotes1794268800000 implements MigrationInterface {
    name = 'AddDashboardNoticePrivateNotes1794268800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dashboard_notices" ADD COLUMN IF NOT EXISTS "is_private" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "dashboard_notices" ADD COLUMN IF NOT EXISTS "is_important" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "dashboard_notices" ADD COLUMN IF NOT EXISTS "color" varchar(12)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dashboard_notices" DROP COLUMN IF EXISTS "color"`);
        await queryRunner.query(`ALTER TABLE "dashboard_notices" DROP COLUMN IF EXISTS "is_important"`);
        await queryRunner.query(`ALTER TABLE "dashboard_notices" DROP COLUMN IF EXISTS "is_private"`);
    }
}
