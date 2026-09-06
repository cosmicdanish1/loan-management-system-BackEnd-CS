import { MigrationInterface, QueryRunner } from 'typeorm';

// suretymaster was keyed only by mbno, with no way to tell which loan case a
// guarantor row belonged to. Confirmed live: a member with 2+ loan cases
// (900000003) has a single suretymaster row that Change Loan Surety would
// silently overwrite for whichever case was edited last, corrupting the
// guarantor record for every other case that member holds. Nullable: null
// means "legacy row, not yet tagged to a specific case" — loan-surety.service
// claims these on first edit rather than leaving them stuck.
export class AddSuretymasterLoanCaseNo1755200000000 implements MigrationInterface {
    name = 'AddSuretymasterLoanCaseNo1755200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('suretymaster');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "suretymaster"
            ADD COLUMN IF NOT EXISTS "loancaseno" numeric
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('suretymaster');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "suretymaster"
            DROP COLUMN IF EXISTS "loancaseno"
        `);
    }
}
