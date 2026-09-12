import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * dividend_master had no uniqueness guarantee at all on (mbno, year), even
 * though it's meant to hold exactly one dividend record per member per
 * financial year — without this, re-running the dividend calculation for a
 * year would insert duplicate rows instead of safely recalculating.
 */
export class AddDividendMasterUniqueConstraint1757500100000 implements MigrationInterface {
    name = 'AddDividendMasterUniqueConstraint1757500100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "dividend_master"
            ADD CONSTRAINT "uq_dividend_master_mbno_year" UNIQUE ("mbno", "year")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dividend_master" DROP CONSTRAINT IF EXISTS "uq_dividend_master_mbno_year"`);
    }
}
