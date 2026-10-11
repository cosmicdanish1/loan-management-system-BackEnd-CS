import { MigrationInterface, QueryRunner } from 'typeorm';

// Where a loan payment came from: 'DEMAND' (payroll deduction through the demand master) or 'CASH'
// (everything else). Demand-master money is tied to its own demand month (payment_month / payment_year)
// and is never pushed onto older unpaid EMIs; it also never pays the same-month late fee. Existing rows
// default to 'CASH' (the old behaviour); migrated history is tagged 'DEMAND' by a separate back-fill
// script (scripts/_backfill-loan-payment-source.ts) that matches the ledger's demand vouchers.
export class AddLoanRepaymentPaymentSource1790726400000 implements MigrationInterface {
    name = 'AddLoanRepaymentPaymentSource1790726400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "loan_repayment_ledger" ADD COLUMN IF NOT EXISTS "payment_source" varchar(10) NOT NULL DEFAULT 'CASH'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "loan_repayment_ledger" DROP COLUMN IF EXISTS "payment_source"`);
    }
}
