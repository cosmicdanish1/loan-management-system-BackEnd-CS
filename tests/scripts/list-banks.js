require('dotenv').config();
const { Client } = require('pg');
async function listBanks() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: process.env.DB_PASSWORD });
    try {
        await client.connect();
        const res = await client.query("SELECT name FROM bankmas");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) { console.error(err); } finally { await client.end(); }
}
listBanks();
