const { Client } = require('pg');
async function searchCodes() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query("SELECT * FROM codes_table WHERE code_name ILIKE '%div%' OR code_desc ILIKE '%div%'");
        console.table(res.rows);
    } catch (err) { console.error(err); } finally { await client.end(); }
}
searchCodes();
