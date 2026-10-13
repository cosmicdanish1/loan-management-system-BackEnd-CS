import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-98: yearly Group Insurance run (lump sum split over active members, pro-rata for late joiners,
// deducted from each member's RD at year end). Same DDL as database/migrations/create-group-insurance.sql.
export class CreateGroupInsurance1791158400000 implements MigrationInterface {
    name = 'CreateGroupInsurance1791158400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('group_insurance_run'))) {
            await queryRunner.query(`
                CREATE TABLE "group_insurance_run" (
                    "id" SERIAL PRIMARY KEY,
                    "yearcode" integer NOT NULL,
                    "fy_label" varchar(20) NOT NULL,
                    "fy_start" date NOT NULL,
                    "fy_end" date NOT NULL,
                    "lump_sum" numeric(14,2) NOT NULL,
                    "active_members" integer NOT NULL,
                    "per_member_amount" numeric(14,4) NOT NULL,
                    "include_retired" boolean NOT NULL DEFAULT true,
                    "posting_date" date NOT NULL,
                    "voucher_no" varchar(20),
                    "charged_members" integer NOT NULL DEFAULT 0,
                    "total_charged" numeric(14,2) NOT NULL DEFAULT 0,
                    "status" varchar(10) NOT NULL DEFAULT 'POSTED',
                    "created_by" varchar(50),
                    "created_at" timestamp NOT NULL DEFAULT now()
                )
            `);
            await queryRunner.query(`CREATE UNIQUE INDEX "uq_group_insurance_run_year" ON "group_insurance_run" ("yearcode") WHERE "status" = 'POSTED'`);
        }
        if (!(await queryRunner.hasTable('group_insurance_charge'))) {
            await queryRunner.query(`
                CREATE TABLE "group_insurance_charge" (
                    "id" SERIAL PRIMARY KEY,
                    "run_id" integer NOT NULL REFERENCES "group_insurance_run"("id"),
                    "mbno" numeric NOT NULL,
                    "months" integer NOT NULL,
                    "calc_amount" numeric(14,4) NOT NULL,
                    "charge" numeric(14,2) NOT NULL,
                    "rd_before" numeric(14,2) NOT NULL,
                    "rd_after" numeric(14,2) NOT NULL,
                    "uncovered" numeric(14,2) NOT NULL DEFAULT 0,
                    UNIQUE ("run_id", "mbno")
                )
            `);
            await queryRunner.query(`CREATE INDEX "idx_group_insurance_charge_mbno" ON "group_insurance_charge" ("mbno")`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "group_insurance_charge"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "group_insurance_run"`);
    }
}
