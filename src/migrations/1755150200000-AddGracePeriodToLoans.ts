import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds configurable EMI grace-period support:
//   - busrules.{rln,eln,aln}gracedays — admin-set days of grace per loan type,
//     edited from Modify Business Rules alongside each type's penal rate.
//   - loan_master.gracedays — the resolved value frozen onto each loan at
//     disbursement time, exactly like rate/penalrate already are, so a later
//     change to busrules never retroactively reprices a live loan.
// Grace only ever waives PENAL for an installment that is genuinely overdue —
// it never waives the interest actually accrued, and (via the accompanying
// code change to exact due-date comparison) it never reaches into an
// installment that isn't due yet.
export class AddGracePeriodToLoans1755150200000 implements MigrationInterface {
    name = 'AddGracePeriodToLoans1755150200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('busrules')) {
            await queryRunner.query(`
                ALTER TABLE "busrules"
                ADD COLUMN IF NOT EXISTS "rlngracedays" smallint,
                ADD COLUMN IF NOT EXISTS "elngracedays" smallint,
                ADD COLUMN IF NOT EXISTS "alngracedays" smallint
            `);
        }
        if (await queryRunner.hasTable('loan_master')) {
            await queryRunner.query(`
                ALTER TABLE "loan_master"
                ADD COLUMN IF NOT EXISTS "gracedays" smallint NOT NULL DEFAULT 0
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('busrules')) {
            await queryRunner.query(`
                ALTER TABLE "busrules"
                DROP COLUMN IF EXISTS "rlngracedays",
                DROP COLUMN IF EXISTS "elngracedays",
                DROP COLUMN IF EXISTS "alngracedays"
            `);
        }
        if (await queryRunner.hasTable('loan_master')) {
            await queryRunner.query(`
                ALTER TABLE "loan_master"
                DROP COLUMN IF EXISTS "gracedays"
            `);
        }
    }
}
