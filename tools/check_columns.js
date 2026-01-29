const { Client } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const config = {
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_DATABASE || 'loan_mgmt'
};

async function check() {
    const client = new Client(config);
    try {
        await client.connect();
        const res = await client.query(`
            SELECT column_name, column_default, is_nullable, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'system_configs'
        `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

check();
