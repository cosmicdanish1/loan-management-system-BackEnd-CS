import { MigrationInterface, QueryRunner } from 'typeorm';

// Repairs LAN installs where `deposit_slabs.id` was restored/created without
// its owned sequence, leaving the column NOT NULL with no default. Every
// insert into deposit_slabs (e.g. the Deposit/Loan Interest Slab "Save"
// action) then fails with "null value in column \"id\" ... violates
// not-null constraint", surfaced to the UI as the generic "Database
// operation failed" message.
export class FixDepositSlabsIdSequence1755000000000 implements MigrationInterface {
    name = 'FixDepositSlabsIdSequence1755000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('deposit_slabs');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`
            CREATE SEQUENCE IF NOT EXISTS "deposit_slabs_id_seq"
        `);

        await queryRunner.query(`
            ALTER SEQUENCE "deposit_slabs_id_seq" OWNED BY "deposit_slabs"."id"
        `);

        await queryRunner.query(`
            SELECT setval(
                '"deposit_slabs_id_seq"',
                GREATEST((SELECT COALESCE(MAX(id), 0) FROM "deposit_slabs"), 1),
                true
            )
        `);

        await queryRunner.query(`
            ALTER TABLE "deposit_slabs"
            ALTER COLUMN "id" SET DEFAULT nextval('"deposit_slabs_id_seq"')
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('deposit_slabs');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "deposit_slabs" ALTER COLUMN "id" DROP DEFAULT
        `);
        await queryRunner.query(`
            DROP SEQUENCE IF EXISTS "deposit_slabs_id_seq"
        `);
    }
}
