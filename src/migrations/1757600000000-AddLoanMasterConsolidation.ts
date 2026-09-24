import { MigrationInterface, QueryRunner } from 'typeorm';

// Loan consolidation: when a member takes a new loan while already carrying
// an active loan of the same type, pass-transaction.service.ts now merges
// the old balance into the new case's own combined loan_amt/balance/EMI,
// rather than leaving two independent payments running side by side (the
// legacy system's own behavior, which this app had no equivalent for — see
// the loan-closure gap analysis this migration accompanies). This column is
// the permanent, queryable link from an absorbed case back to whichever new
// case it was folded into — purely additive, nothing else changes.
export class AddLoanMasterConsolidation1757600000000 implements MigrationInterface {
    name = 'AddLoanMasterConsolidation1757600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_master');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "loan_master"
            ADD COLUMN IF NOT EXISTS "consolidated_into_loancaseno" numeric(18,0)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_master');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "loan_master"
            DROP COLUMN IF EXISTS "consolidated_into_loancaseno"
        `);
    }
}
