import { AppDataSource } from '../config/database.config';

/**
 * One-off data restore for the `busrules` policy table.
 *
 * Background: `busrules` is append-only — every save on the Modify Business
 * Rules screen inserts a whole new row, and every reader takes the one with
 * the newest `appdate`. Between 2026-08-21 and 2026-08-22 sixteen consecutive
 * saves each wrote a row in which *every* column was 0, so the newest row —
 * the only one anything reads — carried no policy at all. The screen then
 * rendered those zeros faithfully, and each further save wrote them back.
 *
 * This appends a fresh row cloned from the last row that still held real
 * values (2026-08-17 19:43:40.910105), with `appdate = now()` so it becomes
 * the current one. Nothing is deleted or updated: the zero rows stay in place
 * as history, and this is reversible by appending another row.
 *
 * The clone goes through to_jsonb/jsonb_populate_record rather than an
 * explicit 58-column list so that every column is carried over verbatim and
 * no column can be missed or transposed by hand.
 */

const SOURCE_APPDATE = '2026-08-17 19:43:40.910105';

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const source = await queryRunner.query(
            `SELECT appdate::text AS appdate, rlnrate, rlnpenalrate, alnrate, alnpenalrate, elnrate, elnpenalrate
             FROM busrules WHERE appdate = $1`,
            [SOURCE_APPDATE]
        );
        if (source.length === 0) {
            throw new Error(`Source row ${SOURCE_APPDATE} not found — refusing to guess a replacement.`);
        }
        console.log('Source row (last known-good):', source[0]);

        const before = await queryRunner.query(
            `SELECT appdate::text AS appdate, rlnrate, rlnpenalrate, alnrate, alnpenalrate, elnrate, elnpenalrate
             FROM busrules ORDER BY appdate DESC LIMIT 1`
        );
        console.log('Current newest row (before restore):', before[0]);

        await queryRunner.query(
            `INSERT INTO busrules
             SELECT (jsonb_populate_record(
                        NULL::busrules,
                        to_jsonb(b) || jsonb_build_object('appdate', now())
                    )).*
             FROM busrules b
             WHERE b.appdate = $1`,
            [SOURCE_APPDATE]
        );

        const after = await queryRunner.query(
            `SELECT appdate::text AS appdate, rlnmaxloanamt, rlnrate, rlnpenalrate, rlnmaxnoinst,
                    elnmaxloanamt, elnrate, elnpenalrate, alnmaxloanamt, alnrate, alnpenalrate,
                    mlnrate, edlrate, loanmaxlimit, loanagainstdeppercent, minmembship, mincdamt, maxcdamt
             FROM busrules ORDER BY appdate DESC LIMIT 1`
        );
        console.log('New newest row (after restore):', after[0]);
        console.log('\nRestored. busrules now resolves to the 2026-08-17 policy values.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Restore failed:', err);
    process.exit(1);
});
