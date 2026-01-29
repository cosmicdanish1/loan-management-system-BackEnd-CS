const { Client } = require('pg');

async function checkLedgerSchema() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- LEDGER TABLE COLUMNS ---');
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'ledger'
        `);
        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkLedgerSchema();
