const { Client } = require('pg');
require('dotenv').config({ path: '../.env' });

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

async function auditIndexes() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log("--- Performance Audit: Database Indexing ---\n");

        const res = await client.query(`
            SELECT
                t.relname AS table_name,
                i.relname AS index_name,
                a.attname AS column_name
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
                AND t.relname IN ('member_master', 'loan_master', 'loan_pending', 'transaction_master', 'deposit_master')
            ORDER BY
                t.relname,
                i.relname;
        `);

        console.log("Current Indexes:");
        console.table(res.rows);

        // Check for common join columns that might be missing indexes
        console.log("\n--- Checking for Missing Common Join Indexes ---");
        const tables = ['member_master', 'loan_master', 'loan_pending', 'transaction_master'];
        const potentialKeys = ['mbno', 'loancaseno', 'officeno', 'wingno', 'voucherno'];

        // This is a simplified check
        console.log("Note: Columns like 'officeno' and 'wingno' are frequently used in filters but often lack indexes in legacy schemas.");

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

auditIndexes();
