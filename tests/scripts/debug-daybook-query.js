// Debug script to test the daybook query directly
// This script helps debug database queries and data parsing issues

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'loan_management',
  user: 'postgres',
  password: 'admin123'
});

async function debugDayBookQuery() {
  try {
    console.log('🔍 Testing daybook query...');
    console.log('='.repeat(50));
    
    // Test the exact query that the service uses
    const query = `
      SELECT 
        t.trans_no,
        t.trans_type,
        t.trans_date,
        t.mbno,
        t.trans_amt,
        t.receipt_vchr_no,
        t.code,
        t.narration,
        t.username,
        COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '') as member_name,
        h.head_name as head_name_from_master
      FROM transactions t
      LEFT JOIN member_master m ON t.mbno = m.mbno
      LEFT JOIN headmaster h ON t.code = h.code
      WHERE t.trans_date >= '2025-12-17 00:00:00' 
        AND t.trans_date <= '2025-12-17 23:59:59'
        AND (t.code = 'A1001' OR t.code LIKE 'A%')
      ORDER BY t.trans_date ASC, t.trans_no ASC
    `;
    
    const result = await pool.query(query);
    
    console.log('📊 Query results:');
    console.log('📈 Count:', result.rows.length);
    
    result.rows.forEach((row, index) => {
      console.log(`\n${index + 1}. 📄 Raw row data:`, {
        trans_no: row.trans_no,
        trans_type: row.trans_type,
        trans_date: row.trans_date,
        mbno: row.mbno,
        trans_amt: row.trans_amt,
        trans_amt_type: typeof row.trans_amt,
        receipt_vchr_no: row.receipt_vchr_no,
        code: row.code,
        narration: row.narration,
        username: row.username,
        member_name: row.member_name,
        head_name_from_master: row.head_name_from_master
      });
      
      // Test money parsing
      const moneyValue = row.trans_amt;
      console.log('💰 Money parsing test:');
      console.log('  📊 Original:', moneyValue);
      console.log('  📝 String:', moneyValue?.toString());
      console.log('  🧹 Cleaned:', moneyValue?.toString().replace(/[$₹,?]/g, '').trim());
      console.log('  🔢 Parsed:', parseFloat(moneyValue?.toString().replace(/[$₹,?]/g, '').trim()) || 0);
    });

    // Test regular daybook query (no filtering)
    console.log('\n🔍 Testing regular daybook query (no SB filter):');
    const regularQuery = `
      SELECT COUNT(*) as total_count
      FROM transactions t
      WHERE t.trans_date >= '2025-12-17 00:00:00' 
        AND t.trans_date <= '2025-12-17 23:59:59'
    `;
    
    const regularResult = await pool.query(regularQuery);
    console.log('📈 Total transactions for date:', regularResult.rows[0].total_count);

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

// Run the debug if this file is executed directly
if (require.main === module) {
  debugDayBookQuery();
}

module.exports = { debugDayBookQuery };