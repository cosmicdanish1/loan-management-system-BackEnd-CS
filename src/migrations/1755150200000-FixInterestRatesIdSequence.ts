import { MigrationInterface, QueryRunner } from 'typeorm';

// Same repair as FixDepositSlabsIdSequence1755000000000, for interest_rates —
// `id` was restored/created without its owned sequence, leaving the column
// NOT NULL with no default. Every insert (e.g. the Interest Rate "Save"
// action) then fails with "null value in column \"id\" ... violates
// not-null constraint", surfaced to the UI as the generic "Database
// operation failed" message. Confirmed live while seeding sample interest
// rate config data.
export class FixInterestRatesIdSequence1755150200000 implements MigrationInterface {
    name = 'FixInterestRatesIdSequence1755150200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('interest_rates');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`
            CREATE SEQUENCE IF NOT EXISTS "interest_rates_id_seq"
        `);

        await queryRunner.query(`
            ALTER SEQUENCE "interest_rates_id_seq" OWNED BY "interest_rates"."id"
        `);

        await queryRunner.query(`
            SELECT setval(
                '"interest_rates_id_seq"',
                GREATEST((SELECT COALESCE(MAX(id), 0) FROM "interest_rates"), 1),
                true
            )
        `);

        await queryRunner.query(`
            ALTER TABLE "interest_rates"
            ALTER COLUMN "id" SET DEFAULT nextval('"interest_rates_id_seq"')
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('interest_rates');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "interest_rates" ALTER COLUMN "id" DROP DEFAULT
        `);
        await queryRunner.query(`
            DROP SEQUENCE IF EXISTS "interest_rates_id_seq"
        `);
    }
}
