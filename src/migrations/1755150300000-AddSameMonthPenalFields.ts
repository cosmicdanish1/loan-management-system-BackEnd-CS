import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds the configurable "Tier 1" same-month-late flat fee, used alongside
// the grace-day cutoff and the existing penal rate (which now only prices
// Tier 2 — a full month or more late):
//   busrules.{rln,eln,aln}smpct / {rln,eln,aln}smdiv — admin-set percentage
//   and divisor for the flat fee, edited per loan type on Modify Business
//   Rules. Formula: (smpct% × installment's own unpaid principal) / smdiv.
//   loan_master.smpenalpct / smpenaldiv — the resolved values frozen onto
//   each loan at disbursement, exactly like rate/penalrate/gracedays already
//   are, so a later change to busrules never retroactively reprices a live
//   loan.
export class AddSameMonthPenalFields1755150300000 implements MigrationInterface {
    name = 'AddSameMonthPenalFields1755150300000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('busrules')) {
            await queryRunner.query(`
                ALTER TABLE "busrules"
                ADD COLUMN IF NOT EXISTS "rlnsmpct" numeric(5,2),
                ADD COLUMN IF NOT EXISTS "elnsmpct" numeric(5,2),
                ADD COLUMN IF NOT EXISTS "alnsmpct" numeric(5,2),
                ADD COLUMN IF NOT EXISTS "rlnsmdiv" numeric(5,2),
                ADD COLUMN IF NOT EXISTS "elnsmdiv" numeric(5,2),
                ADD COLUMN IF NOT EXISTS "alnsmdiv" numeric(5,2)
            `);
        }
        if (await queryRunner.hasTable('loan_master')) {
            await queryRunner.query(`
                ALTER TABLE "loan_master"
                ADD COLUMN IF NOT EXISTS "smpenalpct" numeric(5,2) NOT NULL DEFAULT 1,
                ADD COLUMN IF NOT EXISTS "smpenaldiv" numeric(5,2) NOT NULL DEFAULT 4
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('busrules')) {
            await queryRunner.query(`
                ALTER TABLE "busrules"
                DROP COLUMN IF EXISTS "rlnsmpct",
                DROP COLUMN IF EXISTS "elnsmpct",
                DROP COLUMN IF EXISTS "alnsmpct",
                DROP COLUMN IF EXISTS "rlnsmdiv",
                DROP COLUMN IF EXISTS "elnsmdiv",
                DROP COLUMN IF EXISTS "alnsmdiv"
            `);
        }
        if (await queryRunner.hasTable('loan_master')) {
            await queryRunner.query(`
                ALTER TABLE "loan_master"
                DROP COLUMN IF EXISTS "smpenalpct",
                DROP COLUMN IF EXISTS "smpenaldiv"
            `);
        }
    }
}
