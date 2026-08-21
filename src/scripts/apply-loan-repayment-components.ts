// One-off runner for the AddLoanRepaymentComponents migration.
// `npm run migration:run` walks migrations in timestamp order and fails on
// the pre-existing CreateNotificationLogs entry (applied outside TypeORM's
// tracking table on this install), so it never reaches later migrations.
// This runs just the one migration this fix needs, directly.
import { AppDataSource } from '../config/database.config';
import { AddLoanRepaymentComponents1755100000000 } from '../migrations/1755100000000-AddLoanRepaymentComponents';

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new AddLoanRepaymentComponents1755100000000();
        await migration.up(queryRunner);
        console.log('loan_repayment_ledger: principal_amount, interest_amount, penal_amount, months_overdue columns are in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply loan repayment components migration:', err);
    process.exit(1);
});
