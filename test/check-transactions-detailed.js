// Detailed transaction checker for debugging
// This script provides comprehensive transaction data analysis

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'loan_management',
  user: 'postgres',
  password: 'admin123'
});

async function checkTransactionsDetailed() {
  try {
    console.log('🔍 Checking recent transactions in detail...');
    console.log('='.repeat(60));
    
    // Get recent transactions
    const result = await pool.query(`
      SELECT trans_no, trans_date, trans_type, mbno, trans_amt, code, narration, username
      FROM transactions 
      WHERE trans_date >= '2025-12-17' 
      ORDER BY trans_date DESC, trans_no DESC
      LIMIT 10
    `);
    
    console.log('📊 Recent transactions count:', result.rows.length);
    result.rows.forEach((row, index) => {
      console.log(`\n${index + 1}. 📄 Transaction:`, {
        trans_no: row.trans_no,
        trans_date: row.trans_date,
        trans_type: row.trans_type,
        mbno: row.mbno,
        trans_amt: row.trans_amt,
        code: row.code,
        narration: row.narration,
        username: row.username
      });
    });

    // Check member_master for member names
    console.log('\n👥 Checking member_master...');
    const memberResult = await pool.query(`
      SELECT mbno, f_name, m_name, l_name 
      FROM member_master 
      WHERE mbno IN (SELECT DISTINCT mbno FROM transactions WHERE trans_date >= '2025-12-17')
      LIMIT 5
    `);
    
    console.log('📈 Members found:', memberResult.rows.length);
    memberResult.rows.forEach(member => {
      console.log('👤 Member:', {
        mbno: member.mbno,
        name: `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim()
      });
    });

    // Check headmaster for head names
    console.log('\n💰 Checking headmaster...');
    const headResult = await pool.query(`
      SELECT code, head_name 
      FROM headmaster 
      WHERE code IN (SELECT DISTINCT code FROM transactions WHERE trans_date >= '2025-12-17')
      LIMIT 10
    `);
    
    console.log('📈 Heads found:', headResult.rows.length);
    headResult.rows.forEach(head => {
      console.log('🏷️ Head:', {
        code: head.code,
        head_name: head.head_name
      });
    });

    // Analyze transaction types and amounts
    console.log('\n📊 Transaction Analysis:');
    const analysisResult = await pool.query(`
      SELECT 
        trans_type,
        COUNT(*) as count,
        SUM(CAST(REPLACE(REPLACE(trans_amt::text, '$', ''), ',', '') AS NUMERIC)) as total_amount
      FROM transactions 
      WHERE trans_date >= '2025-12-17'
      GROUP BY trans_type
      ORDER BY trans_type
    `);
    
    analysisResult.rows.forEach(row => {
      console.log(`💳 ${row.trans_type}: ${row.count} transactions, Total: ₹${row.total_amount}`);
    });

    // Check savings-related transactions
    console.log('\n🏦 Savings-related transactions (A codes):');
    const savingsResult = await pool.query(`
      SELECT code, COUNT(*) as count, 
             SUM(CAST(REPLACE(REPLACE(trans_amt::text, '$', ''), ',', '') AS NUMERIC)) as total_amount
      FROM transactions 
      WHERE trans_date >= '2025-12-17' 
        AND code LIKE 'A%'
      GROUP BY code
      ORDER BY code
    `);
    
    savingsResult.rows.forEach(row => {
      console.log(`💰 ${row.code}: ${row.count} transactions, Total: ₹${row.total_amount}`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

// Run the check if this file is executed directly
if (require.main === module) {
  checkTransactionsDetailed();
}

module.exports = { checkTransactionsDetailed };