const { Client } = require('pg');
require('dotenv').config();

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

async function setup() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log('Connected to database');

        // 1. Enable pg_trgm extension
        console.log('Enabling pg_trgm extension...');
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

        // 2. Add full_name column if it doesn't exist
        console.log('Checking full_name column...');
        await client.query(`
            ALTER TABLE member_master 
            ADD COLUMN IF NOT EXISTS full_name VARCHAR(255)
        `);

        // 3. Populate full_name from existing columns
        console.log('Populating full_name column...');
        await client.query(`
            UPDATE member_master 
            SET full_name = TRIM(
                COALESCE(f_name, '') || ' ' || 
                COALESCE(m_name, '') || ' ' || 
                COALESCE(l_name, '')
            )
            WHERE full_name IS NULL OR full_name = ''
        `);

        // 4. Create GIN index for trigram search
        console.log('Creating GIN index on full_name...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_member_full_name_trgm 
            ON member_master 
            USING gin (full_name gin_trgm_ops)
        `);

        console.log('Setup complete');
    } catch (err) {
        console.error('Error setting up FTS:', err);
    } finally {
        await client.end();
    }
}

setup();
