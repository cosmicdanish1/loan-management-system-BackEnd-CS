const { Client } = require('pg');

async function checkHeadMaster() {
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

        const res = await client.query('SELECT * FROM headmaster LIMIT 5');
        console.log('Sample HeadMaster Records:');
        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkHeadMaster();
