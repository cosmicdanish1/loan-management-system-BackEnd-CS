import { AppDataSource } from '../config/database.config';
import { WidenVoucherNumberColumns1791590400000 } from '../migrations/1791590400000-WidenVoucherNumberColumns';

// ES-494: run this once on EVERY database (dev, LAN installs, restored copies of the migrated MS SQL data).
// It widens every voucher number column to varchar(20). Safe to run again: columns that are already wide are skipped,
// no data is changed and nothing is rewritten (widening a varchar is a metadata-only change in PostgreSQL).
//
//   npx ts-node -r tsconfig-paths/register src/scripts/_apply-widen-voucher-number-migration.ts
async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        await new WidenVoucherNumberColumns1791590400000().up(queryRunner);
        const rows = await queryRunner.query(
            `SELECT table_name, column_name, character_maximum_length AS width
               FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name IN ('ledger', 'transactions') AND column_name = 'receipt_vchr_no'`,
        );
        console.log('Voucher number columns are in place:', JSON.stringify(rows));
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
