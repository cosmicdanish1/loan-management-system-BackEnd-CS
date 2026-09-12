import { AppDataSource } from '../config/database.config';
import { AddLoanPendingRateOverrides1755150000000 } from '../migrations/1755150000000-AddLoanPendingRateOverrides';

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new AddLoanPendingRateOverrides1755150000000();
        await migration.up(queryRunner);
        console.log('loan_pending: rate, penalrate columns are in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
