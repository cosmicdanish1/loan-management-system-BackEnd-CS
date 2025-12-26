const { Client } = require('pg');

async function getSampleHeads() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        const res = await client.query('SELECT code, head_name FROM headmaster ORDER BY code LIMIT 20');
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (error) {
        console.error(error);
    } finally {
        await client.end();
    }
}

getSampleHeads();
