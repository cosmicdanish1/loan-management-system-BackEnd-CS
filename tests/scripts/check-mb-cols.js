const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'Test@1212',
    database: process.env.DB_DATABASE || 'EMP_Espat_Society'
});

async function checkColumnTypes() {
    try {
        await client.connect();
        const res = await client.query(`
            SELECT column_name, data_type, udt_name 
            FROM information_schema.columns 
            WHERE table_name = 'member_balances'
            ORDER BY ordinal_position;
        `);
        res.rows.forEach(row => {
            console.log(`${row.column_name}: ${row.data_type} (${row.udt_name})`);
        });
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkColumnTypes();
