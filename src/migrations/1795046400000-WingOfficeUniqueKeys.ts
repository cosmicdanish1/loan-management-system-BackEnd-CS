import { MigrationInterface, QueryRunner } from 'typeorm';

// Wing / Office Master now edit the tables the rest of the application reads: WINGMAST (one row per wing) and
// DIVISION_MASTER (one row per office / branch). The legacy tables have no key at all; the window saves one row per wing
// code and per office number, so both get a unique index. Created only when the data has no duplicates (a duplicate would
// make the index fail and the migration stop); running it twice does nothing new.
export class WingOfficeUniqueKeys1795046400000 implements MigrationInterface {
    name = 'WingOfficeUniqueKeys1795046400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM wingmast GROUP BY wingno HAVING count(*) > 1) THEN
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_wingmast_wingno ON wingmast (wingno);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM division_master GROUP BY officeno HAVING count(*) > 1) THEN
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_division_master_officeno ON division_master (officeno);
                END IF;
            END $$;
        `);
    }

    public async down(): Promise<void> {
        // not reversed: the keys protect the wing and office numbers
    }
}
