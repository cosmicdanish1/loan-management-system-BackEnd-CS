import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkSubTables() {
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
        console.log('--- loan_pending_aln samples ---');
        const aln = await dataSource.query(`SELECT * FROM loan_pending_aln LIMIT 5`);
        console.table(aln);

        console.log('--- loan_pending_rln samples ---');
        const rln = await dataSource.query(`SELECT * FROM loan_pending_rln LIMIT 5`);
        console.table(rln);

        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkSubTables();
