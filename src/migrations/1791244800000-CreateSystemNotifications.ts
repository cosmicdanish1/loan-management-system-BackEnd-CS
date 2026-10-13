import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-101: Notification Centre — stored system notifications with a per-user read state.
// Same DDL as database/migrations/create-system-notifications.sql.
export class CreateSystemNotifications1791244800000 implements MigrationInterface {
    name = 'CreateSystemNotifications1791244800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('system_notifications'))) {
            await queryRunner.query(`
                CREATE TABLE "system_notifications" (
                    "id" SERIAL PRIMARY KEY,
                    "kind" varchar(40) NOT NULL,
                    "severity" varchar(10) NOT NULL DEFAULT 'info',
                    "title" varchar(200) NOT NULL,
                    "body" text,
                    "mbno" numeric,
                    "member_name" varchar(200),
                    "action_path" varchar(120),
                    "action_label" varchar(40),
                    "dedupe_key" varchar(120) NOT NULL UNIQUE,
                    "status" varchar(10) NOT NULL DEFAULT 'OPEN',
                    "created_at" timestamp NOT NULL DEFAULT now(),
                    "updated_at" timestamp NOT NULL DEFAULT now(),
                    "resolved_at" timestamp
                )
            `);
            await queryRunner.query(`CREATE INDEX "idx_system_notifications_status_kind" ON "system_notifications" ("status", "kind")`);
            await queryRunner.query(`CREATE INDEX "idx_system_notifications_mbno" ON "system_notifications" ("mbno")`);
        }
        if (!(await queryRunner.hasTable('system_notification_reads'))) {
            await queryRunner.query(`
                CREATE TABLE "system_notification_reads" (
                    "notification_id" integer NOT NULL REFERENCES "system_notifications"("id") ON DELETE CASCADE,
                    "username" varchar(50) NOT NULL,
                    "read_at" timestamp NOT NULL DEFAULT now(),
                    PRIMARY KEY ("notification_id", "username")
                )
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "system_notification_reads"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "system_notifications"`);
    }
}
