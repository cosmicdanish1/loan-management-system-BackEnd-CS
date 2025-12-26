const { Client } = require('pg');

async function listAllTables() {
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

        const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
        console.log('All Tables:');
        res.rows.forEach((row, i) => console.log(`${i}: ${row.table_name}`));

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

listAllTables();
