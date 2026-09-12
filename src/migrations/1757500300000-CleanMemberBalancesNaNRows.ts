import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 16 member_balances rows had a literal double-precision NaN in mbno (not
 * NULL — a real NaN, which Postgres treats as self-equal and greater than
 * every value, silently breaking any query that assumes "mbno > 0" or
 * "mbno = x" excludes garbage). Every other identifying field on these rows
 * (srno, pfno, member_name, officeno) was also NULL, and every numeric
 * balance was exactly 1.00 — unmistakably leftover synthetic test-data
 * fixture rows, not corrupted real member records, so they're deleted
 * outright rather than repaired. mbno had no NOT NULL constraint at all,
 * which is how this slipped in silently; added here so it can't recur.
 */
export class CleanMemberBalancesNaNRows1757500300000 implements MigrationInterface {
    name = 'CleanMemberBalancesNaNRows1757500300000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM member_balances WHERE mbno::text = 'NaN'`);
        await queryRunner.query(`ALTER TABLE "member_balances" ALTER COLUMN "mbno" SET NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "member_balances" ALTER COLUMN "mbno" DROP NOT NULL`);
        // The deleted rows themselves are not restorable (they carried no
        // real data to reconstruct).
    }
}
