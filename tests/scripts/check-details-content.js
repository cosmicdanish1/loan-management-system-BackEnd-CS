const { Client } = require('pg');

async function checkDetails() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        const res = await client.query("SELECT * FROM report_schedule_details");
        console.log(res.rows);
    } catch (error) {
        console.error(error);
    } finally {
        await client.end();
    }
}

checkDetails();
