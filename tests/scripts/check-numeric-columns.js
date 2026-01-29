const { Client } = require('pg');

async function checkColumns() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        const res = await client.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('numeric', 'money', 'real', 'double precision', 'integer', 'bigint', 'smallint')");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (error) {
        console.error(error);
    } finally {
        await client.end();
    }
}

checkColumns();
