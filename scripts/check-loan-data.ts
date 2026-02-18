import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkLoanData() {
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
        console.log('--- loan_pending counts ---');
        const lpCounts = await dataSource.query(`
            SELECT flg_sanctioned, flg_paid, COUNT(*) 
            FROM loan_pending 
            GROUP BY flg_sanctioned, flg_paid
        `);
        console.table(lpCounts);

        console.log('--- other loan tables ---');
        const alnCounts = await dataSource.query(`SELECT COUNT(*) FROM loan_pending_aln`);
        const rlnCounts = await dataSource.query(`SELECT COUNT(*) FROM loan_pending_rln`);
        const masterCounts = await dataSource.query(`SELECT COUNT(*) FROM loan_master`);
        console.log('ALN:', alnCounts[0].count);
        console.log('RLN:', rlnCounts[0].count);
        console.log('Master:', masterCounts[0].count);

        await dataSource.destroy();
    } catch (error) {
        console.error('Check failed:', error);
    }
}
checkLoanData();
