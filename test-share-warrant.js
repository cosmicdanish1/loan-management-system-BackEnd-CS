const { Client } = require('pg');
const fs = require('fs');

async function testShareWarrantData() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    await client.connect();
    console.log('✅ Connected to database\n');

    try {
        // Check member_balances table structure
        console.log('=== Member Balances Table Structure ===');
        const mbCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'member_balances'
      ORDER BY ordinal_position
    `);
        console.log('Columns:', mbCols.rows);

        // Count records
        const count = await client.query('SELECT COUNT(*) as count FROM member_balances');
        console.log('\nTotal records in member_balances:', count.rows[0].count);

        // Get sample data
        console.log('\n=== Sample Member Balance Data ===');
        const sample = await client.query(`
      SELECT mb.*, mm.f_name, mm.m_name, mm.l_name
      FROM member_balances mb
      LEFT JOIN member_master mm ON mb.member_id::text = mm.mbno::text
      LIMIT 5
    `);
        console.log(JSON.stringify(sample.rows, null, 2));

        // Check if we need to populate data
        if (count.rows[0].count == 0) {
            console.log('\n⚠️  No data found. Populating sample data...');

            // Get some member IDs
            const members = await client.query('SELECT mbno FROM member_master LIMIT 5');

            for (const member of members.rows) {
                await client.query(`
          INSERT INTO member_balances (member_id, shares, created_at, updated_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT DO NOTHING
        `, [member.mbno, Math.floor(Math.random() * 1000) + 100]);
            }

            console.log('✅ Sample data populated');

            // Re-check
            const newSample = await client.query(`
        SELECT mb.*, mm.f_name, mm.m_name, mm.l_name
        FROM member_balances mb
        LEFT JOIN member_master mm ON mb.member_id::text = mm.mbno::text
        LIMIT 5
      `);
            console.log('\nNew sample data:', JSON.stringify(newSample.rows, null, 2));
        }

        // Check what data type shares column is
        console.log('\n=== Data Type Check ===');
        const dataTypeCheck = await client.query(`
      SELECT data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_name = 'member_balances' AND column_name = 'shares'
    `);
        console.log('Shares column type:', dataTypeCheck.rows[0]);

        // If it's not numeric, we should convert it
        if (dataTypeCheck.rows[0].data_type === 'double precision') {
            console.log('\n⚠️  Shares column is double precision, should convert to numeric(19,4)');
            console.log('Recommendation: Run migration to convert to proper numeric type');
        }

    } catch (error) {
        console.error('Error:', error.message);
        console.error(error.stack);
    } finally {
        await client.end();
    }
}

testShareWarrantData();
