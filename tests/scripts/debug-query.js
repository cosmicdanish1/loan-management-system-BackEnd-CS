const { Client } = require('pg');

async function debugQuery() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        console.log('Connected to database');

        const detail = { code_from: 'A001', code_to: 'A005' };
        const fromDate = '2025-12-26';
        const toDate = '2025-12-26';

        console.log('Running currentResult query...');
        const res = await client.query(`
      SELECT 
        SUM(CASE WHEN trans_type = 'CR' THEN trans_amt ELSE 0 END) as "currentReceipts",
        SUM(CASE WHEN trans_type = 'DR' THEN trans_amt ELSE 0 END) as "currentPayments"
      FROM ledger
      WHERE code >= $1 AND code <= $2
      AND trans_date >= $3::timestamp
      AND trans_date <= $4::timestamp
    `, [detail.code_from, detail.code_to, fromDate, toDate]);

        console.log('Result:', res.rows[0]);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

debugQuery();
