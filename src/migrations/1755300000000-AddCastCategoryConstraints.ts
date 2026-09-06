import { MigrationInterface, QueryRunner } from 'typeorm';

// castcategorymaster had zero DB-level constraints — not even a PRIMARY KEY on
// `id`, despite the TypeORM entity declaring one. The app-level "id already
// exists" / "name already exists" checks in CastCategoryService are check-then-
// insert and race-prone without a backing constraint. Confirmed live via
// information_schema/pg_indexes: no constraints, no indexes at all.
//
// Also seeds the two category names ("General", "OBC") that real member_master
// rows already carry but that have never existed as castcategorymaster rows —
// the Member Master "Cast Category" dropdown was hardcoded independently of
// this table (see MemberMaster/interface/interface.ts) and is being wired to
// fetch from here instead. Without these rows, existing members' categories
// would have no matching master entry once the dropdown switches to live data.
export class AddCastCategoryConstraints1755300000000 implements MigrationInterface {
    name = 'AddCastCategoryConstraints1755300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('castcategorymaster');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`
            ALTER TABLE "castcategorymaster"
            ADD CONSTRAINT "PK_castcategorymaster_id" PRIMARY KEY ("id")
        `);

        // Seed only if no case/whitespace-insensitive match already exists, and
        // only if member data actually references the name — keeps this a no-op
        // on any environment that doesn't have the same legacy drift.
        for (const name of ['General', 'OBC']) {
            await queryRunner.query(
                `
                INSERT INTO "castcategorymaster" (id, castcategory)
                SELECT COALESCE((SELECT MAX(id) FROM "castcategorymaster"), 0) + 1, $1::varchar
                WHERE EXISTS (
                    SELECT 1 FROM member_master WHERE LOWER(TRIM(cast_category)) = LOWER(TRIM($1::text))
                )
                AND NOT EXISTS (
                    SELECT 1 FROM "castcategorymaster" WHERE LOWER(TRIM(castcategory)) = LOWER(TRIM($1::text))
                )
                `,
                [name]
            );
        }

        // Unique on the normalized name — matches the case/whitespace-insensitive
        // matching CastCategoryService already uses for rename-cascade and the
        // delete-in-use guard, so two rows can no longer alias the same member data.
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_castcategorymaster_name_ci"
            ON "castcategorymaster" (LOWER(TRIM(castcategory)))
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('castcategorymaster');
        if (!hasTable) {
            return;
        }

        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_castcategorymaster_name_ci"`);
        await queryRunner.query(`
            ALTER TABLE "castcategorymaster" DROP CONSTRAINT IF EXISTS "PK_castcategorymaster_id"
        `);
    }
}
