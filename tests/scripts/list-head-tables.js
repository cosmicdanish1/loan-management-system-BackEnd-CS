require('dotenv').config();
const { Client } = require('pg');

async function listHeadTables() {
    const client = new Client({
        user: 'postgres',
        host: 'localhost',
        database: 'EMP_Espat_Society',
        password: process.env.DB_PASSWORD,
        port: 5432,
    });

    try {
        await client.connect();
        console.log('Connected to DB');

        const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%head%'");
        console.log('Tables with "head":');
        console.table(res.rows);

        const res2 = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%master%'");
        console.log('Tables with "master":');
        console.table(res2.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

listHeadTables();
