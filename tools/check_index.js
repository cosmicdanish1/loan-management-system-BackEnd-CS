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
            SELECT 
                a.attname as column_name,
                i.relname as index_name,
                ix.indisunique as is_unique
            FROM 
                pg_class t,
                pg_class i,
                pg_index ix,
                pg_attribute a
            WHERE 
                t.oid = ix.indrelid
                AND i.oid = ix.indexrelid
                AND a.attrelid = t.oid
                AND a.attnum = ANY(ix.indkey)
                AND t.relkind = 'r'
                AND t.relname = 'system_configs';
        `);
        console.table(res.rows);
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

check();
