import { DataSource } from 'typeorm';
import { AddPayrollLagCredit1758900000000 } from '../migrations/1758900000000-AddPayrollLagCredit';

// AppDataSource (config/database.config.ts) reads process.env.* directly with
// no dotenv loader anywhere in that file — fine inside the full Nest
// bootstrap (which does load .env), but this standalone script never
// triggers that, so it silently fell back to the wrong default credentials.
// Same explicit connection details used by every other one-off script this
// session (matches backend/.env).
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
        const migration = new AddPayrollLagCredit1758900000000();
        await migration.up(queryRunner);
        console.log('loan_master.payroll_lag_* and loan_repayment_ledger.is_payroll_lag_credit are in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
