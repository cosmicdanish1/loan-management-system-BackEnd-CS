const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'Test@1212',
    database: process.env.DB_DATABASE || 'EMP_Espat_Society'
});

async function testJoinQuery() {
    try {
        await client.connect();

        // Try to join member_balances and member_master
        // Try assuming mm.member_no corresponds to mb.mbno (casted)
        const query = `
            SELECT 
              mb.mbno, 
              mm.wingno, 
              mm.officeno 
            FROM member_balances mb
            JOIN member_master mm ON CAST(mb.mbno AS NUMERIC) = CAST(mm.mbno AS NUMERIC)
            LIMIT 5;
        `;

        console.log('Testing JOIN query...');
        const res = await client.query(query);
        console.log('Success! Rows:', res.rows);

    } catch (err) {
        console.error('JOIN Failed:', err.message);

        // Fallback check
        console.log('Checking member_master columns again...');
        const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'member_master' AND column_name LIKE '%no%'`);
        console.log(res.rows.map(r => r.column_name));
    } finally {
        await client.end();
    }
}

testJoinQuery();
