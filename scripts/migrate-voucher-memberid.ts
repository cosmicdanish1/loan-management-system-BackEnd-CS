import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

async function runMigration() {
    const dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        username: process.env.DB_USERNAME || 'postgres',
        password: process.env.DB_PASSWORD || 'admin',
        database: process.env.DB_DATABASE || 'EMP_Espat_Society',
    });

    try {
        await dataSource.initialize();
        console.log('Connected to database');

        console.log('Altering vouchers table...');
        await dataSource.query('ALTER TABLE vouchers ALTER COLUMN "memberId" TYPE numeric');
        console.log('Successfully altered memberId column type to numeric');

        await dataSource.destroy();
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

runMigration();
