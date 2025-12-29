const { Client } = require('pg');
async function checkBusRules() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query("SELECT * FROM busrules LIMIT 1");
        console.log(JSON.stringify(res.rows[0], null, 2));
    } catch (err) { console.error(err); } finally { await client.end(); }
}
checkBusRules();
