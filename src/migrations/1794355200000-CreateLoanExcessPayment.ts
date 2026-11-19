import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-551: one row per repayment that brought in more than was due (an "excess" / advance payment).
// The money itself is still applied exactly as before (loan_repayment_ledger rows); this table is only the
// record of the event so it can be shown in the Loan Repayment / Early Closure windows, the Loan Position
// panel and the notification centre. Nothing reads it to decide how a payment is applied.
export class CreateLoanExcessPayment1794355200000 implements MigrationInterface {
    name = 'CreateLoanExcessPayment1794355200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "loan_excess_payment" (
                "id" SERIAL PRIMARY KEY,
                "mbno" numeric NOT NULL,
                "loancaseno" varchar(50) NOT NULL,
                "loantype" varchar(20),
                "payment_date" date NOT NULL,
                "receipt_no" varchar(100),
                "payment_source" varchar(10) NOT NULL DEFAULT 'CASH',
                "amount_received" numeric(15,2) NOT NULL,
                "due_cleared" numeric(15,2) NOT NULL DEFAULT 0,
                "excess_amount" numeric(15,2) NOT NULL,
                "applied_amount" numeric(15,2) NOT NULL DEFAULT 0,
                "unapplied_amount" numeric(15,2) NOT NULL DEFAULT 0,
                "applied_installments" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "narration" text,
                "posted_by" varchar(100),
                "created_at" timestamptz NOT NULL DEFAULT now()
            )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_loan_excess_payment_loan" ON "loan_excess_payment" ("mbno", "loancaseno")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_loan_excess_payment_created" ON "loan_excess_payment" ("created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "loan_excess_payment"`);
    }
}
