const { Client } = require('pg');
require('dotenv').config();

async function checkData() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USERNAME || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE || 'employeesociety_new'}`
    });

    try {
        await client.connect();

        console.log('--- voucher_staging content ---');
        const resVs = await client.query('SELECT * FROM voucher_staging');
        console.table(resVs.rows);

        console.log('\n--- loan_pending content (first 5) ---');
        const resLp = await client.query('SELECT loancaseno, mbno, flg_paid FROM loan_pending LIMIT 5');
        console.table(resLp.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkData();
