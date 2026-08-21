import { MigrationInterface, QueryRunner } from 'typeorm';

// The Loan Sanction screen already has "Rate" and "Penalty Rate" fields and
// already sends them to the sanction endpoint — but loan_pending has no
// columns to persist them to, so they've always been silently dropped.
// Nullable: null means "no per-case override, use the rule master default."
export class AddLoanPendingRateOverrides1755150000000 implements MigrationInterface {
    name = 'AddLoanPendingRateOverrides1755150000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_pending');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "loan_pending"
            ADD COLUMN IF NOT EXISTS "rate" numeric(19,4),
            ADD COLUMN IF NOT EXISTS "penalrate" numeric(10,2)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_pending');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "loan_pending"
            DROP COLUMN IF EXISTS "rate",
            DROP COLUMN IF EXISTS "penalrate"
        `);
    }
}
