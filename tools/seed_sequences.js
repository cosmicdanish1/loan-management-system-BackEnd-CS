const { Client } = require('pg');
require('dotenv').config();

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

async function seed() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log('Connected to database');

        // 1. Create table if not exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS sequence_master (
                sequence_key VARCHAR(255) PRIMARY KEY,
                last_value BIGINT DEFAULT 0,
                prefix VARCHAR(50),
                reset_yearly BOOLEAN DEFAULT FALSE,
                last_year INTEGER,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Helper to set sequence
        const setSeq = async (key, query, fallback = 0) => {
            const res = await client.query(query);
            const val = res.rows[0].max_val || fallback;
            await client.query(`
                INSERT INTO sequence_master (sequence_key, last_value)
                VALUES ($1, $2)
                ON CONFLICT (sequence_key) DO UPDATE SET last_value = $2
            `, [key, val]);
            console.log(`Initialized ${key} to ${val}`);
        };

        // 3. Seed sequences
        await setSeq('MEMBER_NO', "SELECT MAX(mbno::bigint) as max_val FROM member_master WHERE mbno::text ~ '^[0-9]+$'", 10000000);
        await setSeq('LOAN_CASE', "SELECT MAX(loancaseno::bigint) as max_val FROM loan_pending WHERE loancaseno::text ~ '^[0-9]+$'", 10000);
        await setSeq('VOUCHER_ID', "SELECT MAX(id) as max_val FROM vouchers", 0);

        // Voucher NO is more complex (VCH001), just start from max of numeric part
        const vchRes = await client.query(`
            SELECT MAX(num) as max_val FROM (
                SELECT CAST(SUBSTRING("voucherNumber" FROM 4) AS INTEGER) as num FROM vouchers WHERE "voucherNumber" LIKE 'VCH%'
                UNION ALL
                SELECT CAST(SUBSTRING(voucher_no FROM 4) AS INTEGER) as num FROM voucher_staging WHERE voucher_no LIKE 'VCH%'
            ) t
        `);
        const vchMax = vchRes.rows[0].max_val || 0;
        await client.query(`
            INSERT INTO sequence_master (sequence_key, last_value, prefix, reset_yearly, last_year)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (sequence_key) DO UPDATE SET last_value = $2
        `, ['VOUCHER_NO', vchMax, 'VCH', true, new Date().getFullYear()]);
        console.log(`Initialized VOUCHER_NO to ${vchMax}`);

        console.log('Seeding complete');
    } catch (err) {
        console.error('Error seeding sequences:', err);
    } finally {
        await client.end();
    }
}

seed();
