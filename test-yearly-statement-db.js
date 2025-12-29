const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'Test@1212',
    database: process.env.DB_DATABASE || 'EMP_Espat_Society'
});

async function checkMemberBalances() {
    try {
        await client.connect();
        console.log('Connected to DB');

        // Check if member_balances table exists
        const tableCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'member_balances'
            );
        `);

        const exists = tableCheck.rows[0].exists;
        console.log(`Table 'member_balances' exists: ${exists}`);

        if (exists) {
            const count = await client.query('SELECT COUNT(*) FROM member_balances');
            console.log(`Row count in member_balances: ${count.rows[0].count}`);

            if (parseInt(count.rows[0].count) > 0) {
                const sample = await client.query('SELECT * FROM member_balances LIMIT 1');
                console.log('Sample row:', sample.rows[0]);
            }
        } else {
            console.log('Checking annualstatement table instead...');
            const annualCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'annualstatement'
                );
            `);
            console.log(`Table 'annualstatement' exists: ${annualCheck.rows[0].exists}`);

            if (annualCheck.rows[0].exists) {
                const count = await client.query('SELECT COUNT(*) FROM annualstatement');
                console.log(`Row count in annualstatement: ${count.rows[0].count}`);
                const sample = await client.query('SELECT * FROM annualstatement LIMIT 1');
                console.log('Sample row:', sample.rows[0]);
            }
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

checkMemberBalances();
