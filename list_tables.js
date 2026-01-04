const { Client } = require('pg');
require('dotenv').config();

async function listTables() {
    const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:Test@1212@localhost:5432/EMP_Espat_Society';
    const client = new Client({ connectionString });

    try {
        await client.connect();
        console.log(`Connected to: ${connectionString.split('/').pop()}`);

        const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

        console.log('Tables in database:');
        res.rows.forEach(row => console.log(` - ${row.table_name}`));

        const resVs = await client.query("SELECT count(*)::text FROM voucher_staging");
        console.log(`\nvoucher_staging count: ${resVs.rows[0].count}`);

    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

listTables();
