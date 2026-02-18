import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkMemberAndRo() {
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

        console.log('--- Member Sample ---');
        const members = await dataSource.query(`SELECT mbno, f_name, wingno FROM member_master LIMIT 5`);
        console.table(members);

        console.log('--- RO National Sample ---');
        const roN = await dataSource.query(`SELECT * FROM ro_national LIMIT 5`);
        console.table(roN);

        console.log('--- RO United Sample ---');
        const roU = await dataSource.query(`SELECT * FROM ro_united LIMIT 5`);
        console.table(roU);

        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkMemberAndRo();
