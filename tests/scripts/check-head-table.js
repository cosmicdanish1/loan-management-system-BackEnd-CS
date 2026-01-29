const { Client } = require('pg');

async function checkHeadTable() {
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

        const res = await client.query("SELECT * FROM tblmemberdetledgerhead LIMIT 10");
        console.log('Sample tblmemberdetledgerhead:');
        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkHeadTable();
