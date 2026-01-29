const { Client } = require('pg');

async function checkTables() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'report_schedule%'");
        console.log(res.rows);
    } catch (error) {
        console.error(error);
    } finally {
        await client.end();
    }
}

checkTables();
