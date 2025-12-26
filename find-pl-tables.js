const { Client } = require('pg');

async function findTables() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name LIKE '%pl%' OR table_name LIKE '%profit%' OR table_name LIKE '%loss%')");
        console.log('Target Tables:', res.rows.map(r => r.table_name));

        for (const table of res.rows.map(r => r.table_name)) {
            const cols = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table}'`);
            console.log(`Table: ${table}`);
            console.log(cols.rows);
        }

    } catch (error) {
        console.error(error);
    } finally {
        await client.end();
    }
}

findTables();
