const { Client } = require('pg');

async function checkLedgerConstraints() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- Checking NOT NULL columns ---');
        const res = await client.query(`
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'ledger'
        `);

        res.rows.forEach(r => {
            console.log(`${r.column_name}: Nullable=${r.is_nullable}, Default=${r.column_default}`);
        });

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkLedgerConstraints();
