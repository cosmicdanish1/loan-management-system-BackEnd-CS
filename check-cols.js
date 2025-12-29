const { Client } = require('pg');
async function checkTable(tableName) {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableName}'`);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) { console.error(err); } finally { await client.end(); }
}
const tableName = process.argv[2] || 'codes_table';
checkTable(tableName);
