import { MigrationInterface, QueryRunner } from 'typeorm';

// busrules has rlnpenalrate, edlpenalrate, flnpenalrate — but no dedicated
// column for ELN (Emergency Loan) or ALN (Additional Loan) penal rates, the
// two other loan types actually used by this app. Disbursement code was
// reusing edlpenalrate as a stand-in for "the non-RLN penal rate" because
// there was nothing else to read. Adds the missing columns so ELN and ALN
// can each have their own configurable penal rate like RLN already does.
export class AddBusRulesElnAlnPenalRate1755150100000 implements MigrationInterface {
    name = 'AddBusRulesElnAlnPenalRate1755150100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('busrules');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "busrules"
            ADD COLUMN IF NOT EXISTS "elnpenalrate" numeric(10,2),
            ADD COLUMN IF NOT EXISTS "alnpenalrate" numeric(10,2)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('busrules');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "busrules"
            DROP COLUMN IF EXISTS "elnpenalrate",
            DROP COLUMN IF EXISTS "alnpenalrate"
        `);
    }
}
