import { MigrationInterface, QueryRunner } from 'typeorm';

// A loan's penal rate normally comes from Business Rules (per loan type) and follows any later change there.
// loan_master.penalrate is only an origination-time snapshot: most migrated loans hold 0.00 in it, so it can not be
// read as "this loan has its own rate". A rate the sanctioning officer deliberately set for ONE loan (with a reason)
// is stored here instead. NULL = no exception, Business Rules apply. Nullable, no default, so every existing loan
// keeps its current behaviour.
export class AddLoanMasterPenalOverride1794528000000 implements MigrationInterface {
    name = 'AddLoanMasterPenalOverride1794528000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('loan_master'))) return;
        await queryRunner.query(`ALTER TABLE "loan_master" ADD COLUMN IF NOT EXISTS "penal_override" numeric(6,2)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('loan_master'))) return;
        await queryRunner.query(`ALTER TABLE "loan_master" DROP COLUMN IF EXISTS "penal_override"`);
    }
}
