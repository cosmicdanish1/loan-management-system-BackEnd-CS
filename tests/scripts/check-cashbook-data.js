const { Client } = require('pg');

async function checkCashBook() {
    const client = new Client({
        user: 'postgres',
        host: 'localhost',
        database: 'EMP_Espat_Society',
        password: 'Test@1212',
        port: 5432,
    });

    try {
        await client.connect();
        console.log('Connected to DB');

        const res = await client.query('SELECT * FROM transactions LIMIT 5');
        console.log('Sample Transactions:');
        console.table(res.rows);

        const checkCodes = await client.query(`
      SELECT DISTINCT code 
      FROM transactions 
      WHERE code IN ('A1001', 'A1002', 'E4001', 'E4002', 'I3001')
    `);
        console.log('Found codes in transactions:');
        console.table(checkCodes.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkCashBook();
