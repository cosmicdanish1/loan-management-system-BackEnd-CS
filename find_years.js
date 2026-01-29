const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_DATABASE || 'EMP_Espat_Society',
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'Test@1212',
});

async function findYearCodes() {
    try {
        await client.connect();
        const res = await client.query('SELECT yearcode FROM yearend ORDER BY yearcode DESC LIMIT 5');
        console.log('Valid Year Codes found:', res.rows.map(r => r.yearcode));
    } catch (err) {
        console.error('Error finding year codes:', err.message);
    } finally {
        await client.end();
    }
}

findYearCodes();
