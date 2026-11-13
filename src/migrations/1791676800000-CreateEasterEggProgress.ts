import { MigrationInterface, QueryRunner } from 'typeorm';

// Easter-egg hunt: which hidden eggs each user has found, and when they found them all.
// Idempotent, so it is safe to run on every install.
export class CreateEasterEggProgress1791676800000 implements MigrationInterface {
    name = 'CreateEasterEggProgress1791676800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "easter_egg_progress" (
                "user_id" varchar(64) PRIMARY KEY,
                "display_name" varchar(200) NOT NULL DEFAULT '',
                "found" text[] NOT NULL DEFAULT '{}',
                "completed_at" timestamptz NULL,
                "updated_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "easter_egg_progress"`);
    }
}
