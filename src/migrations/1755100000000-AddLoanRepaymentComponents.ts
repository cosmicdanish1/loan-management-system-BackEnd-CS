import { MigrationInterface, QueryRunner } from 'typeorm';

// loan_repayment_ledger previously stored only a single lump payment_amount,
// so a repayment couldn't be broken into what actually paid down the loan
// (principal) vs what was owed anyway (equalised interest) vs overdue penal
// interest. Adds the three components so LoanRepaymentService can record and
// later report on them separately, per the loan calculation spec.
export class AddLoanRepaymentComponents1755100000000 implements MigrationInterface {
    name = 'AddLoanRepaymentComponents1755100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_repayment_ledger');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "loan_repayment_ledger"
            ADD COLUMN IF NOT EXISTS "principal_amount" numeric(18,2) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "interest_amount" numeric(18,2) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "penal_amount" numeric(18,2) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "months_overdue" integer NOT NULL DEFAULT 0
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_repayment_ledger');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "loan_repayment_ledger"
            DROP COLUMN IF EXISTS "principal_amount",
            DROP COLUMN IF EXISTS "interest_amount",
            DROP COLUMN IF EXISTS "penal_amount",
            DROP COLUMN IF EXISTS "months_overdue"
        `);
    }
}
