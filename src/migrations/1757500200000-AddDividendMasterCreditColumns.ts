import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dividend CREDIT is a deliberately separate concept from is_paid (which
 * tracks whether the member later withdrew the dividend as cash) and from
 * the calculation itself (year/share_amount/dividend_rate/dividend_amount,
 * written when the dividend is first calculated). credited_at marks the
 * one-time event of adding this row's dividend_amount into the member's
 * Share Value at the FOLLOWING financial year's close; credited_year is the
 * calendar year that close happened in, kept distinct from `year` (the
 * calculation year) per the user's explicit "Dividend Calculation Year and
 * Dividend Credit Year must stay distinct" requirement.
 */
export class AddDividendMasterCreditColumns1757500200000 implements MigrationInterface {
    name = 'AddDividendMasterCreditColumns1757500200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dividend_master" ADD COLUMN IF NOT EXISTS "credited_at" timestamp`);
        await queryRunner.query(`ALTER TABLE "dividend_master" ADD COLUMN IF NOT EXISTS "credited_year" integer`);
        await queryRunner.query(`ALTER TABLE "dividend_master" ADD COLUMN IF NOT EXISTS "credited_by" varchar(100)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dividend_master" DROP COLUMN IF EXISTS "credited_at"`);
        await queryRunner.query(`ALTER TABLE "dividend_master" DROP COLUMN IF EXISTS "credited_year"`);
        await queryRunner.query(`ALTER TABLE "dividend_master" DROP COLUMN IF EXISTS "credited_by"`);
    }
}
