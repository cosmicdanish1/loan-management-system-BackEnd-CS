import { DataSource } from 'typeorm';
import { AddLoanPaymentFlags1790640000000 } from '../migrations/1790640000000-AddLoanPaymentFlags';

// Same standalone-credential one-off pattern as _apply-legacy-replay-batch-log-migration.ts
// (npm run migration:run fails on an older migration — see project notes).
const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        await new AddLoanPaymentFlags1790640000000().up(queryRunner);
        console.log('loan_payment_flags table is in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}
main().catch((err) => { console.error('Failed to apply migration:', err); process.exit(1); });
