const { Client } = require('pg');

async function checkLedgerCols() {
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

        const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'ledger'");
        console.log('Ledger columns:');
        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkLedgerCols();
