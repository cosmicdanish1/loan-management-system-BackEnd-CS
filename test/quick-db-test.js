// Quick database test using the same config as the backend
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

async function quickTest() {
  try {
    console.log('Testing database connection...');
    
    // Test basic connection
    const client = await pool.connect();
    console.log('✅ Connected to database');
    
    // Check if tables exist
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('member_master', 'headmaster', 'ledger')
      ORDER BY table_name
    `);
    
    console.log('📋 Available tables:', tablesResult.rows.map(r => r.table_name));
    
    // Check member_master
    const memberCount = await client.query('SELECT COUNT(*) as count FROM member_master');
    console.log(`👥 Members in database: ${memberCount.rows[0].count}`);
    
    // If no members, create a simple test member
    if (parseInt(memberCount.rows[0].count) === 0) {
      console.log('Creating test member...');
      await client.query(`
        INSERT INTO member_master (mbno, prefix, f_name, m_name, l_name, sex, desig, isactive)
        VALUES ('100001', 'Mr', 'John', 'A', 'Doe', 'M', 'Manager', 'Y')
      `);
      console.log('✅ Test member created');
    }
    
    // Check headmaster
    const headCount = await client.query('SELECT COUNT(*) as count FROM headmaster');
    console.log(`🏢 Head masters in database: ${headCount.rows[0].count}`);
    
    // If no heads, create a simple test head
    if (parseInt(headCount.rows[0].count) === 0) {
      console.log('Creating test head master...');
      await client.query(`
        INSERT INTO headmaster (code, head_name, headtype)
        VALUES ('A1002', 'SAVINGS BANK ACCOUNT', 'BANK')
      `);
      console.log('✅ Test head master created');
    }
    
    // Check ledger
    const ledgerCount = await client.query('SELECT COUNT(*) as count FROM ledger');
    console.log(`📊 Ledger entries in database: ${ledgerCount.rows[0].count}`);
    
    // If no ledger entries, create a simple test entry
    if (parseInt(ledgerCount.rows[0].count) === 0) {
      console.log('Creating test ledger entry...');
      await client.query(`
        INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, narration, username)
        VALUES (1001, '2024-12-01', 'CR', 'A1002', 100001, 0, 'SB', 5000.00, 'Test deposit', 'admin')
      `);
      console.log('✅ Test ledger entry created');
    }
    
    // Show final counts
    const finalMemberCount = await client.query('SELECT COUNT(*) as count FROM member_master');
    const finalHeadCount = await client.query('SELECT COUNT(*) as count FROM headmaster');
    const finalLedgerCount = await client.query('SELECT COUNT(*) as count FROM ledger');
    
    console.log('\n📊 Final Database Status:');
    console.log(`  Members: ${finalMemberCount.rows[0].count}`);
    console.log(`  Head Masters: ${finalHeadCount.rows[0].count}`);
    console.log(`  Ledger Entries: ${finalLedgerCount.rows[0].count}`);
    
    client.release();
    console.log('\n🎉 Database test complete!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

quickTest();