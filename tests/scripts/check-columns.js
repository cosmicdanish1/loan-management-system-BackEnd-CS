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
        const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'report_schedule_details'");
        console.log(res.rows.map(r => r.column_name));
    } catch (error) {
        console.error(error);
    } finally {
        await client.end();
    }
}

checkColumns();
