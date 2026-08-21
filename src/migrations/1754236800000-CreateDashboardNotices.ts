import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDashboardNotices1754236800000 implements MigrationInterface {
    name = 'CreateDashboardNotices1754236800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."dashboard_notices_type_enum"
            AS ENUM('info', 'warning', 'success')
        `);

        await queryRunner.query(`
            CREATE TABLE "dashboard_notices" (
                "id"         SERIAL                                          NOT NULL,
                "title"      character varying(200)                         NOT NULL,
                "message"    text                                           NOT NULL,
                "type"       "public"."dashboard_notices_type_enum"         NOT NULL DEFAULT 'info',
                "sort_order" integer                                        NOT NULL DEFAULT 0,
                "posted_by"  character varying(100)                        NOT NULL,
                "created_at" TIMESTAMP                                      NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP                                      NOT NULL DEFAULT now(),
                CONSTRAINT "PK_dashboard_notices_id" PRIMARY KEY ("id")
            )
        `);

        await queryRunner.query(`
            CREATE INDEX "IDX_dashboard_notices_sort_order" ON "dashboard_notices" ("sort_order")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dashboard_notices_sort_order"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "dashboard_notices"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."dashboard_notices_type_enum"`);
    }
}
