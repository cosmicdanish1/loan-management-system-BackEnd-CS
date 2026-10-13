import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-100: audit trail for manually marking a member inactive / re-activating them
// (Member Status window). The status itself stays on member_master.isactive.
export class CreateMemberStatusLog1791072000000 implements MigrationInterface {
    name = 'CreateMemberStatusLog1791072000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('member_status_log'))) {
            await queryRunner.query(`
                CREATE TABLE "member_status_log" (
                    "id" SERIAL PRIMARY KEY,
                    "mbno" numeric NOT NULL,
                    "action" varchar(20) NOT NULL,
                    "reason" text,
                    "retirement_date" date,
                    "rd_balance" numeric(14,2),
                    "loan_balance" numeric(14,2),
                    "forced" boolean NOT NULL DEFAULT false,
                    "done_by" varchar(50),
                    "done_at" timestamp NOT NULL DEFAULT now()
                )
            `);
            await queryRunner.query(`CREATE INDEX "idx_member_status_log_mbno" ON "member_status_log" ("mbno", "done_at" DESC)`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "member_status_log"`);
    }
}
