import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Withdrawal previously only drew from the rd_balance_events opening-balance
 * pot, leaving money paid in via monthly installments (rd_installment_ledger)
 * unwithdrawable — a member who only ever pays installments (the common
 * case) could never withdraw anything. Rather than reduce paid_amount itself
 * (which would corrupt the pattern-eligibility/interest history for that
 * installment), a separate withdrawn_amount tracks how much of that specific
 * installment has since been drawn out, so paid_amount - withdrawn_amount is
 * always "how much of this installment's money is still actually there."
 */
export class AddRdInstallmentWithdrawnAmount1757400000000 implements MigrationInterface {
    name = 'AddRdInstallmentWithdrawnAmount1757400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "rd_installment_ledger"
            ADD COLUMN IF NOT EXISTS "withdrawn_amount" numeric(19,4) NOT NULL DEFAULT 0
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "rd_installment_ledger" DROP COLUMN IF EXISTS "withdrawn_amount"`);
    }
}
