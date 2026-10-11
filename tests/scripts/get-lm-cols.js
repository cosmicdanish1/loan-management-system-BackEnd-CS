require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

async function check() {
    const client = new Client({
        host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: process.env.DB_PASSWORD
    });
    await client.connect();
    const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'loan_pending'");
    fs.writeFileSync('lp_cols.txt', res.rows.map(r => r.column_name).join('\n'));
    await client.end();
}
check();
