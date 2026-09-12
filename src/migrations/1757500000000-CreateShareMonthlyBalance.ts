import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Monthly Share Capital balance snapshot — the historical data source the
 * dividend calculation needs (Total Product = sum of each month's closing
 * Share balance for a financial year), which member_balances.shares alone
 * can't provide since it's only ever a single current running number.
 * Mirrors loan_monthly_balance's exact shape/pattern (same capture-at-
 * month-end, upsert-safe design), just for Shares instead of loan balances.
 */
export class CreateShareMonthlyBalance1757500000000 implements MigrationInterface {
    name = 'CreateShareMonthlyBalance1757500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "share_monthly_balance" (
                "id" SERIAL PRIMARY KEY,
                "mbno" numeric(18,0) NOT NULL,
                "snapshot_month" integer NOT NULL,
                "snapshot_year" integer NOT NULL,
                "share_balance" numeric(19,4) NOT NULL DEFAULT 0,
                "snapshot_date" date NOT NULL DEFAULT CURRENT_DATE,
                "created_at" timestamp NOT NULL DEFAULT NOW(),
                CONSTRAINT "uq_share_monthly_balance_mbno_month_year" UNIQUE ("mbno", "snapshot_month", "snapshot_year")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_share_monthly_balance_mbno_year" ON "share_monthly_balance" ("mbno", "snapshot_year")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "share_monthly_balance"`);
    }
}
