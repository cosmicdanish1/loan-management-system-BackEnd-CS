import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotificationLogs1748044800000 implements MigrationInterface {
    name = 'CreateNotificationLogs1748044800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create enum types
        await queryRunner.query(`
            CREATE TYPE "public"."notification_logs_channel_enum"
            AS ENUM('SMS', 'WHATSAPP', 'EMAIL')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."notification_logs_type_enum"
            AS ENUM('TRANSACTION', 'EMI_ALERT', 'LOAN_QUERY', 'MANUAL', 'MONTHLY_SUMMARY')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."notification_logs_status_enum"
            AS ENUM('PENDING', 'SENT', 'FAILED', 'CANCELLED')
        `);

        // Create table
        await queryRunner.query(`
            CREATE TABLE "notification_logs" (
                "id"           SERIAL                                              NOT NULL,
                "mbno"         numeric,
                "channel"      "public"."notification_logs_channel_enum"           NOT NULL DEFAULT 'SMS',
                "type"         "public"."notification_logs_type_enum"              NOT NULL DEFAULT 'MANUAL',
                "message"      text                                                NOT NULL,
                "recipient"    character varying(100),
                "status"       "public"."notification_logs_status_enum"            NOT NULL DEFAULT 'PENDING',
                "errorMessage" text,
                "sentAt"       TIMESTAMP,
                "metadata"     jsonb,
                "createdAt"    TIMESTAMP                                           NOT NULL DEFAULT now(),
                "updatedAt"    TIMESTAMP                                           NOT NULL DEFAULT now(),
                CONSTRAINT "PK_notification_logs_id" PRIMARY KEY ("id")
            )
        `);

        // Index for fast member-based queries
        await queryRunner.query(`
            CREATE INDEX "IDX_notification_logs_mbno" ON "notification_logs" ("mbno")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_notification_logs_status" ON "notification_logs" ("status")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_notification_logs_createdAt" ON "notification_logs" ("createdAt")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notification_logs_createdAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notification_logs_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notification_logs_mbno"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "notification_logs"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."notification_logs_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."notification_logs_type_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."notification_logs_channel_enum"`);
    }
}
