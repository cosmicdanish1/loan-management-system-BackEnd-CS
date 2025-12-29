const { Client } = require('pg');
async function run() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });
    await client.connect();
    const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ledger'");
    console.log(JSON.stringify(res.rows, null, 2));
    await client.end();
}
run();
