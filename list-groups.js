const { Client } = require('pg');
async function listGroups() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query("SELECT DISTINCT grp_name FROM codes_table");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) { console.error(err); } finally { await client.end(); }
}
listGroups();
