import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkHeadMaster() {
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

        console.log('--- Head Master Shares/Thrift/Interest ---');
        // Search using "code" column for specific heads
        const heads = await dataSource.query(`
            SELECT * FROM headmaster 
            WHERE head_name ILIKE '%share%' 
               OR head_name ILIKE '%thrift%' 
               OR head_name ILIKE '%fund%' 
               OR head_name ILIKE '%interest%'
               OR head_name ILIKE '%dividend%'
               OR head_name ILIKE '%insurance%'
        `);
        console.table(heads);

        console.log('--- A1002/A1047 Codes ---');
        const specific = await dataSource.query(`
            SELECT * FROM headmaster 
            WHERE code IN ('A1002', 'A1047')
        `);
        console.table(specific);

        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkHeadMaster();
