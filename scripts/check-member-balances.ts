import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkMemberColumns() {
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
        const cols = await dataSource.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'member_master' AND (column_name LIKE '%bal%' OR column_name LIKE '%amt%' OR column_name LIKE '%fund%' OR column_name LIKE '%share%')
        `);
        console.table(cols);
        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkMemberColumns();
