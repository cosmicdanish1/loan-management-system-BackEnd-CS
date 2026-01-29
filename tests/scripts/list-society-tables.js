const { Client } = require('pg');
async function listTables() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%society%'");
        console.table(res.rows);
    } catch (err) { console.error(err); } finally { await client.end(); }
}
listTables();
