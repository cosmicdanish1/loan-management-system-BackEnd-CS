import { MigrationInterface, QueryRunner } from 'typeorm';

// Tracking table for the Phase 2 bulk ledger-replay migration (see
// backend/src/scripts/phase2/bulk_ledger_replay.ts). Replaying ~137K legacy
// repayment rows across ~3,643 real members through the live NestJS service
// stack is a long-running, resumable job, not a single transaction — this
// table is how the script knows what it already finished if it's stopped
// and restarted, and is the audit trail reviewed before anything here is
// trusted. One row per member per run attempt; never written to by the app
// itself, only by the replay script.
export class AddLegacyReplayBatchLog1759100000000 implements MigrationInterface {
    name = 'AddLegacyReplayBatchLog1759100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = await queryRunner.hasTable('legacy_replay_batch_log');
        if (!exists) {
            await queryRunner.query(`
                CREATE TABLE "legacy_replay_batch_log" (
                    "id" SERIAL PRIMARY KEY,
                    "mbno" varchar(20) NOT NULL,
                    "status" varchar(20) NOT NULL DEFAULT 'pending',
                    "dry_run" boolean NOT NULL DEFAULT true,
                    "cases_processed" integer NOT NULL DEFAULT 0,
                    "repayments_replayed" integer NOT NULL DEFAULT 0,
                    "consolidations_applied" integer NOT NULL DEFAULT 0,
                    "flags" jsonb,
                    "error_message" text,
                    "started_at" timestamptz,
                    "finished_at" timestamptz,
                    "created_at" timestamptz NOT NULL DEFAULT now()
                )
            `);
            await queryRunner.query(`
                CREATE UNIQUE INDEX "idx_legacy_replay_batch_log_mbno" ON "legacy_replay_batch_log" ("mbno")
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "legacy_replay_batch_log"`);
    }
}
