import { MigrationInterface, QueryRunner } from 'typeorm';

// Foundation tables for the new RD (Recurring Deposit) system, built from
// scratch to replace the fdmaster/fdrdflag='R' account system removed this
// session (confirmed zero real production data). Per the user's explicit
// spec: RD and CD share the same GL head (L1004) and the same collection
// pipeline (Demand Generation -> Ledger Posting) — these tables exist purely
// to track the RD-specific things that pipeline doesn't: which member chose
// what monthly amount, per-installment pay/miss/arrears-clearance history
// (for the payment-pattern eligibility engine), the balance-change timeline
// (for period-based opening-balance interest), and the year-end audit record.
//
// Financial year = April-March throughout, keyed by yearend.yearcode (the
// existing, already-real financial-year table) — no separate FY table needed.
export class CreateRdSystemTables1757300000000 implements MigrationInterface {
    name = 'CreateRdSystemTables1757300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Member's chosen monthly RD amount, as a history (mid-year changes
        // are allowed per the user, so this is append-only — "current amount"
        // = the latest row by effective_from_date <= today, for a given
        // member+year).
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "rd_member_config" (
                "id" SERIAL PRIMARY KEY,
                "mbno" numeric(18,0) NOT NULL,
                "yearcode" integer NOT NULL,
                "monthly_rd_amount" numeric(19,4) NOT NULL,
                "effective_from_date" date NOT NULL DEFAULT CURRENT_DATE,
                "set_by" varchar(40),
                "created_at" timestamp NOT NULL DEFAULT NOW()
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_rd_member_config_mbno_year" ON "rd_member_config" ("mbno", "yearcode", "effective_from_date")
        `);

        // Per-installment payment history — one row per due month, updated as
        // it's paid (on time or as an arrear clearance later). Mirrors
        // loan_repayment_ledger's proven oldest-first shape so the pattern
        // engine can reuse the same "was this a current payment or an arrear
        // clearance" distinction already proven correct for loans.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "rd_installment_ledger" (
                "id" SERIAL PRIMARY KEY,
                "mbno" numeric(18,0) NOT NULL,
                "yearcode" integer NOT NULL,
                "installment_month" integer NOT NULL,
                "installment_year" integer NOT NULL,
                "due_date" date NOT NULL,
                "expected_amount" numeric(19,4) NOT NULL,
                "paid_amount" numeric(19,4) NOT NULL DEFAULT 0,
                "paid_date" date,
                "is_arrear_clearance" boolean NOT NULL DEFAULT false,
                "receipt_no" varchar(40),
                "narration" varchar(255),
                "created_at" timestamp NOT NULL DEFAULT NOW(),
                CONSTRAINT "uq_rd_installment_mbno_year_month" UNIQUE ("mbno", "yearcode", "installment_month", "installment_year")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_rd_installment_ledger_mbno_year" ON "rd_installment_ledger" ("mbno", "yearcode")
        `);

        // Balance-change timeline — every event that changes what balance is
        // earning opening-balance interest (opening figure itself, a
        // withdrawal, a loan-linked 5% shortfall addition, or an interest
        // credit). The opening-balance interest calculator walks these in
        // date order and computes balance x monthly-rate x months-held per
        // period, per the user's worked examples.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "rd_balance_events" (
                "id" SERIAL PRIMARY KEY,
                "mbno" numeric(18,0) NOT NULL,
                "yearcode" integer NOT NULL,
                "event_date" date NOT NULL,
                "event_type" varchar(30) NOT NULL,
                "amount" numeric(19,4) NOT NULL,
                "resulting_balance" numeric(19,4) NOT NULL,
                "narration" varchar(255),
                "created_by" varchar(40),
                "created_at" timestamp NOT NULL DEFAULT NOW()
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_rd_balance_events_mbno_year_date" ON "rd_balance_events" ("mbno", "yearcode", "event_date")
        `);

        // Financial-year closing / audit record — one row per member per
        // year, holding every field the user's spec's "Auditability" section
        // asked for: payment history summary, detected pattern, automatic and
        // final eligibility, both interest figures computed independently,
        // the rate actually used (frozen here so a later rate change never
        // alters an already-closed year), and the authority override if any.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "rd_financial_year_summary" (
                "id" SERIAL PRIMARY KEY,
                "mbno" numeric(18,0) NOT NULL,
                "yearcode" integer NOT NULL,
                "opening_balance" numeric(19,4) NOT NULL DEFAULT 0,
                "monthly_rd_amount" numeric(19,4) NOT NULL DEFAULT 0,
                "total_installments_due" integer NOT NULL DEFAULT 0,
                "total_installments_paid" integer NOT NULL DEFAULT 0,
                "total_missed" integer NOT NULL DEFAULT 0,
                "arrears_cleared" boolean NOT NULL DEFAULT false,
                "payment_pattern_detected" varchar(30),
                "auto_eligible_full_interest" boolean NOT NULL DEFAULT false,
                "authority_override" boolean,
                "authority_override_by" varchar(40),
                "authority_override_at" timestamp,
                "authority_override_reason" varchar(255),
                "final_eligible_full_interest" boolean NOT NULL DEFAULT false,
                "rd_installment_interest" numeric(19,4) NOT NULL DEFAULT 0,
                "opening_balance_interest" numeric(19,4) NOT NULL DEFAULT 0,
                "opening_balance_interest_rate" numeric(6,3) NOT NULL DEFAULT 0,
                "total_interest_credited" numeric(19,4) NOT NULL DEFAULT 0,
                "closing_balance" numeric(19,4) NOT NULL DEFAULT 0,
                "closed_at" timestamp,
                "closed_by" varchar(40),
                "created_at" timestamp NOT NULL DEFAULT NOW(),
                CONSTRAINT "uq_rd_fy_summary_mbno_year" UNIQUE ("mbno", "yearcode")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_rd_fy_summary_year" ON "rd_financial_year_summary" ("yearcode")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "rd_financial_year_summary"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "rd_balance_events"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "rd_installment_ledger"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "rd_member_config"`);
    }
}
