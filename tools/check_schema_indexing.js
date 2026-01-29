const { Client } = require('pg');
require('dotenv').config({ path: '../.env' });

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

async function checkSchema() {
    const client = new Client(config);
    try {
        await client.connect();
        const res = await client.query(`
            SELECT table_name, column_name 
            FROM information_schema.columns 
            WHERE table_name = 'transactions'
        `);
        console.log("Columns in transactions:");
        console.log(res.rows.map(r => r.column_name).join(', '));
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkSchema();
