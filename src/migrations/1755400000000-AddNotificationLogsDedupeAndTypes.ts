import { MigrationInterface, QueryRunner } from 'typeorm';

// notification_logs.dedupeKey / msgRef are declared on the NotificationLog
// entity and read/written by NotificationService (sendNotification,
// queueNotification's dedup check) but were never added by any migration —
// CreateNotificationLogs1748044800000 only created the original columns.
// Confirmed live: every read of a single row fails with
// "column NotificationLog.dedupeKey does not exist", which breaks
// Send / Retry / Send-batch / Compose-Queue across the whole Communication Hub.
//
// Also brings notification_logs_type_enum in sync with the entity's full
// NotificationType list — LOAN_APPLICATION/LOAN_DISBURSED/TRANSACTION_POSTED/
// INTEREST_CREDITED already exist in the live enum (added by hand outside any
// migration at some point), but MATURITY_ALERT and MEMBER_UPDATE do not, so
// scheduleDepositMaturityAlerts() would fail the same way on first use.
export class AddNotificationLogsDedupeAndTypes1755400000000 implements MigrationInterface {
    name = 'AddNotificationLogsDedupeAndTypes1755400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('notification_logs');
        if (!hasTable) {
            return;
        }

        const hasDedupeKey = await queryRunner.hasColumn('notification_logs', 'dedupeKey');
        if (!hasDedupeKey) {
            await queryRunner.query(`
                ALTER TABLE "notification_logs" ADD COLUMN "dedupeKey" character varying(64)
            `);
            await queryRunner.query(`
                CREATE UNIQUE INDEX "UQ_notification_logs_dedupeKey" ON "notification_logs" ("dedupeKey")
            `);
        }

        const hasMsgRef = await queryRunner.hasColumn('notification_logs', 'msgRef');
        if (!hasMsgRef) {
            await queryRunner.query(`
                ALTER TABLE "notification_logs" ADD COLUMN "msgRef" character varying(30)
            `);
        }

        for (const value of ['MATURITY_ALERT', 'MEMBER_UPDATE']) {
            await queryRunner.query(`
                ALTER TYPE "public"."notification_logs_type_enum" ADD VALUE IF NOT EXISTS '${value}'
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('notification_logs');
        if (!hasTable) {
            return;
        }
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_notification_logs_dedupeKey"`);
        await queryRunner.query(`ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "dedupeKey"`);
        await queryRunner.query(`ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "msgRef"`);
        // Postgres has no "remove enum value" — down() intentionally leaves MATURITY_ALERT/MEMBER_UPDATE in place.
    }
}
