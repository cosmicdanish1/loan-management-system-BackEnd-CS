import { MigrationInterface, QueryRunner } from 'typeorm';

// "Check these" flags raised when a loan payment (Loan Repayment screen) or a
// demand-import row (Excel/CSV) looks like it could be the OLD loan's EMI that
// payroll keeps deducting after a consolidation, rather than the NEW loan's EMI
// — see loan-payment-flag.service.ts. Flags never change how money is applied;
// they only ask a person to check, and can be marked checked.
export class AddLoanPaymentFlags1790640000000 implements MigrationInterface {
    name = 'AddLoanPaymentFlags1790640000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = await queryRunner.hasTable('loan_payment_flags');
        if (!exists) {
            await queryRunner.query(`
                CREATE TABLE "loan_payment_flags" (
                    "id" SERIAL PRIMARY KEY,
                    "source" varchar(20) NOT NULL,
                    "mbno" numeric NOT NULL,
                    "loantype" varchar(10),
                    "loancaseno" varchar(30),
                    "flag_code" varchar(30) NOT NULL,
                    "message" text NOT NULL,
                    "amount" numeric(14,2),
                    "principal_amount" numeric(14,2),
                    "interest_amount" numeric(14,2),
                    "event_date" date NOT NULL,
                    "period_month" integer,
                    "period_year" integer,
                    "status" varchar(10) NOT NULL DEFAULT 'OPEN',
                    "created_at" timestamp NOT NULL DEFAULT now(),
                    "created_by" varchar(50),
                    "checked_at" timestamp,
                    "checked_by" varchar(50),
                    "checked_note" text
                )
            `);
            await queryRunner.query(`CREATE INDEX "idx_loan_payment_flags_mbno_status" ON "loan_payment_flags" ("mbno", "status")`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "loan_payment_flags"`);
    }
}
