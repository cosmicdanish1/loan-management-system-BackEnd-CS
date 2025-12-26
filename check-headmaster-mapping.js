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

        const res = await client.query("SELECT * FROM headmaster WHERE code IN ('A1001', 'A1002', 'E4001', 'E4002', 'I3001')");
        console.log('Mapping results:');
        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkHeadMaster();
