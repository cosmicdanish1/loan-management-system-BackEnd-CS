import { AppDataSource } from '../config/database.config';
import { AddLoanMasterDelayMonths1757700000000 } from '../migrations/1757700000000-AddLoanMasterDelayMonths';

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new AddLoanMasterDelayMonths1757700000000();
        await migration.up(queryRunner);
        console.log('loan_master.delay_months is in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
