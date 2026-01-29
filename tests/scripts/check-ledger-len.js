const { Client } = require('pg');

async function checkLedgerLengths() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        const res = await client.query(`
            SELECT column_name, data_type, character_maximum_length
            FROM information_schema.columns 
            WHERE table_name = 'ledger'
        `);

        res.rows.forEach(r => {
            console.log(`${r.column_name}: ${r.data_type} (${r.character_maximum_length})`);
        });

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkLedgerLengths();
