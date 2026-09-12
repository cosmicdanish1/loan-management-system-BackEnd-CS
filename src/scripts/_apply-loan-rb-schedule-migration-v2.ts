import { DataSource } from 'typeorm';
import { CreateLoanRbSchedule1755150400000 } from '../migrations/1755150400000-CreateLoanRbSchedule';

const AppDataSource = new DataSource({
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'EMP_Espat_Society',
    username: 'postgres',
    password: 'Test@1212',
    synchronize: false,
});

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new CreateLoanRbSchedule1755150400000();
        await migration.up(queryRunner);
        console.log('loan_rb_schedule table is in place (verified target: EMP_Espat_Society).');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
