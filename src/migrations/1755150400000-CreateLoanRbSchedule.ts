import { MigrationInterface, QueryRunner } from 'typeorm';

// Persists the TRUE reducing-balance schedule for a loan, separate from the
// single flat instal_amt figure loan_master has always stored. Needed because
// the constant-EMI figure a member actually pays no longer represents what
// interest has genuinely accrued month-to-month on the declining balance —
// early closure needs the real number, not the flat average.
//
// Method: equal principal each month (loan_amt / n), interest computed on the
// declining opening balance each month (opening_balance × monthlyRate) — NOT
// the standard bank EMI-amortization method (equal payment, growing
// principal). Confirmed with the user this cooperative society's own rule is
// the equal-principal / declining-interest method.
export class CreateLoanRbSchedule1755150400000 implements MigrationInterface {
    name = 'CreateLoanRbSchedule1755150400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "loan_rb_schedule" (
                "id" SERIAL PRIMARY KEY,
                "loancaseno" numeric(18,0) NOT NULL,
                "mbno" numeric(18,0) NOT NULL,
                "installment_no" smallint NOT NULL,
                "opening_balance" numeric(19,4) NOT NULL,
                "rb_interest" numeric(19,4) NOT NULL,
                "principal" numeric(19,4) NOT NULL,
                "closing_balance" numeric(19,4) NOT NULL,
                "created_at" timestamp NOT NULL DEFAULT NOW(),
                CONSTRAINT "uq_loan_rb_schedule_case_instal" UNIQUE ("loancaseno", "installment_no")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_loan_rb_schedule_loancaseno" ON "loan_rb_schedule" ("loancaseno")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "loan_rb_schedule"`);
    }
}
