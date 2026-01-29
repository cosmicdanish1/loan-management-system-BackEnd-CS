const { Client } = require('pg');
require('dotenv').config({ path: '../.env' });

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

async function checkConstraints() {
    const client = new Client(config);
    try {
        await client.connect();
        const res = await client.query(`
            SELECT conname, contype 
            FROM pg_constraint 
            WHERE conrelid = 'member_master'::regclass
            OR conrelid = 'loan_pending'::regclass
        `);
        console.log("Constraints found:");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkConstraints();
