const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'Test@1212',
    database: process.env.DB_DATABASE || 'EMP_Espat_Society'
});

async function updateSchema() {
    try {
        await client.connect();
        console.log('Connected to DB');

        const columnsToUpdate = [
            'shares',
            'compulsory_deposit',
            'regularloan',
            'emergency_loan_balance',
            'regularinstallamt',
            'einstallamt',
            'int_amount',
            'eint_amount',
            'frsbalance',
            'rd_amt',
            'dr_cr'
        ];

        for (const col of columnsToUpdate) {
            console.log(`Updating ${col} to NUMERIC(18, 2)...`);
            try {
                await client.query(`
                    ALTER TABLE member_balances 
                    ALTER COLUMN ${col} TYPE NUMERIC(18, 2);
                `);
                console.log(`Success: ${col}`);
            } catch (e) {
                console.error(`Failed to update ${col}:`, e.message);
            }
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

updateSchema();
