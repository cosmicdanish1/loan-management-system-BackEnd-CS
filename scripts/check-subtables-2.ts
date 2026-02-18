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
        const aln = await dataSource.query(`SELECT COUNT(*) FROM loan_pending_aln WHERE flg_paid = 'Y'`);
        const rln = await dataSource.query(`SELECT COUNT(*) FROM loan_pending_rln WHERE flg_paid = 'Y'`);
        console.log('Paid ALN in sub-table:', aln[0].count);
        console.log('Paid RLN in sub-table:', rln[0].count);

        const aln_meta = await dataSource.query(`SELECT loancaseNo, flg_sanctioned, flg_paid FROM loan_pending_aln LIMIT 5`);
        console.log('ALN Meta:', aln_meta);

        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkSubTables();
