const { Client } = require('pg');

const client = new Client({
    user: 'postgres',
    host: 'localhost',
    database: 'EMP_Espat_Society',
    password: 'Test@1212',
    port: 5432,
});

async function createVoucherTables() {
    try {
        await client.connect();
        console.log('Connected to database.');

        // 1. Create voucher_staging table
        await client.query(`
            CREATE TABLE IF NOT EXISTS voucher_staging (
                id SERIAL PRIMARY KEY,
                voucher_no VARCHAR(20) UNIQUE NOT NULL,
                loan_case_no VARCHAR(20),
                amount DECIMAL(15, 2),
                payment_mode VARCHAR(20),
                bank_details VARCHAR(200),
                cheque_no VARCHAR(50),
                cheque_date DATE,
                narration TEXT,
                is_posted BOOLEAN DEFAULT FALSE,
                status VARCHAR(20) DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by VARCHAR(50)
            );
        `);
        console.log('Table voucher_staging created or already exists.');

        // 2. Create voucher_staging_details table
        await client.query(`
            CREATE TABLE IF NOT EXISTS voucher_staging_details (
                id SERIAL PRIMARY KEY,
                voucher_no VARCHAR(20) REFERENCES voucher_staging(voucher_no) ON DELETE CASCADE,
                sr_no INTEGER,
                code VARCHAR(10),
                name VARCHAR(100),
                type VARCHAR(20), -- 'Payment' or 'Receipt'
                amount DECIMAL(15, 2)
            );
        `);
        console.log('Table voucher_staging_details created or already exists.');

    } catch (err) {
        console.error('Error creating tables:', err);
    } finally {
        await client.end();
    }
}

createVoucherTables();
