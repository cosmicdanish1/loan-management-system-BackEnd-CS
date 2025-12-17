const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function setupSampleData() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL database');

    // Read and execute the SQL file
    const sqlFile = path.join(__dirname, '..', 'create-sample-data.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');
    
    // Split by semicolon and execute each statement
    const statements = sql.split(';').filter(stmt => stmt.trim().length > 0);
    
    for (const statement of statements) {
      try {
        await client.query(statement);
        console.log('✅ Executed SQL statement');
      } catch (error) {
        if (error.message.includes('duplicate key')) {
          console.log('ℹ️  Data already exists, skipping...');
        } else {
          console.error('❌ Error executing statement:', error.message);
        }
      }
    }

    // Verify the data
    console.log('\n📊 Verifying sample data...');
    
    const memberCount = await client.query('SELECT COUNT(*) as count FROM member_master');
    console.log(`Members: ${memberCount.rows[0].count}`);
    
    const headCount = await client.query('SELECT COUNT(*) as count FROM headmaster');
    console.log(`Head Masters: ${headCount.rows[0].count}`);
    
    const ledgerCount = await client.query('SELECT COUNT(*) as count FROM ledger');
    console.log(`Ledger Entries: ${ledgerCount.rows[0].count}`);

    // Show sample members
    const members = await client.query(`
      SELECT mbno, f_name, m_name, l_name 
      FROM member_master 
      WHERE mbno IN ('100001', '100002', '100003')
      ORDER BY mbno
    `);
    
    console.log('\n👥 Sample Members:');
    members.rows.forEach(row => {
      const fullName = `${row.f_name} ${row.m_name} ${row.l_name}`;
      console.log(`  ${row.mbno}: ${fullName}`);
    });

    // Show sample ledger entries for member 100001
    const ledgerEntries = await client.query(`
      SELECT trans_date, code, trans_type, trans_amt, narration
      FROM ledger 
      WHERE mbno = 100001
      ORDER BY trans_date
    `);
    
    console.log('\n📋 Sample Ledger Entries for Member 100001:');
    ledgerEntries.rows.forEach(row => {
      const date = row.trans_date.toISOString().split('T')[0];
      console.log(`  ${date} | ${row.code} | ${row.trans_type} | ₹${row.trans_amt} | ${row.narration}`);
    });

    console.log('\n🎉 Sample data setup complete!');
    console.log('\n🧪 Test the Member Ledger Report with:');
    console.log('  - Member Number: 100001');
    console.log('  - Head Code: A1002 (Savings Bank Account)');
    console.log('  - Date Range: 2024-11-01 to 2025-12-17');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await client.end();
  }
}

setupSampleData();