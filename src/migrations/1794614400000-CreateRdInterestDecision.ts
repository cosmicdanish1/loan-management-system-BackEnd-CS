import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-629: the employee's Allow / Deny decision on a member's RD/CD year-end interest. One row per member and financial
// year (the latest decision replaces the earlier one; the person, the reason and the time are kept).
//   ALLOW = a late instalment counts as paid on time (interest from its due month)
//   DENY  = interest only from the month the money was actually deposited (also the default when there is no row)
export class CreateRdInterestDecision1794614400000 implements MigrationInterface {
    name = 'CreateRdInterestDecision1794614400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "rd_interest_decision" (
                "id" SERIAL PRIMARY KEY,
                "mbno" numeric(18,0) NOT NULL,
                "yearcode" integer NOT NULL,
                "decision" varchar(5) NOT NULL CHECK ("decision" IN ('ALLOW', 'DENY')),
                "reason" varchar(300),
                "decided_by" varchar(60) NOT NULL,
                "decided_at" timestamp NOT NULL DEFAULT NOW(),
                CONSTRAINT "uq_rd_interest_decision_member_year" UNIQUE ("mbno", "yearcode")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "rd_interest_decision"`);
    }
}
