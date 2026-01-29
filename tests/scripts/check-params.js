const { Client } = require('pg');

async function checkParams() {
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

        const res = await client.query("SELECT * FROM parameter_setting LIMIT 20");
        console.log('Sample parameter_setting:');
        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkParams();
