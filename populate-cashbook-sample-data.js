const { Pool } = require('pg');
require('dotenv').config();

// Database configuration from environment
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'EMP_Espat_Society',
  password: process.env.DB_PASSWORD || 'admin',
  port: process.env.DB_PORT || 5432,
});

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function populateCashBookData() {
  log('🏦 POPULATING CASHBOOK SAMPLE DATA', 'cyan');
  
  try {
    // Get next transaction number
    const nextTransResult = await pool.query('SELECT COALESCE(MAX(trans_no), 0) + 1 as next_trans_no FROM transactions');
    let transNo = nextTransResult.rows[0].next_trans_no;
    
    log(`Starting from transaction number: ${transNo}`, 'blue');
    
    // Sample transactions for today
    const today = new Date().toISOString().split('T')[0];
    const transactions = [
      {
        date: today,
        type: 'CR',
        amount: 25000.00,
        code: 'A1001',
        narration: 'Member Savings Deposit',
        mbno: 1001
      },
      {
        date: today,
        type: 'CR',
        amount: 50000.00,
        code: 'A1002',
        narration: 'Fixed Deposit Opening',
        mbno: 1002
      },
      {
        date: today,
        type: 'DR',
        amount: 15000.00,
        code: 'E4002',
        narration: 'Administrative Expenses',
        mbno: 0
      },
      {
        date: today,
        type: 'CR',
        amount: 8000.00,
        code: 'I3001',
        narration: 'Interest Income',
        mbno: 0
      },
      {
        date: today,
        type: 'DR',
        amount: 12000.00,
        code: 'E4001',
        narration: 'Interest Payment',
        mbno: 1003
      }
    ];
    
    let successCount = 0;
    
    for (const tx of transactions) {
      try {
        // Insert transaction
        await pool.query(`
          INSERT INTO transactions (
            trans_no, trans_date, trans_type, mbno, acc_no, acc_type,
            trans_amt, receipt_vchr_no, vchr_type, modeofpay, cheq_no,
            cheq_amt, pass_flag, cashier_flag, code, narration, username
          ) VALUES (
            $1, $2, $3, $4, 0, 'SB',
            $5, $6, $7, 'C', '',
            '0.00', 'N', 'N', $8, $9, 'system'
          )
        `, [
          transNo,
          tx.date,
          tx.type,
          tx.mbno,
          tx.amount,
          `${tx.type}${String(transNo).padStart(3, '0')}`,
          tx.type === 'CR' ? 'R' : 'P',
          tx.code,
          tx.narration
        ]);
        
        // Insert ledger entry
        await pool.query(`
          INSERT INTO ledger (
            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
            narration, username, ledgerid
          ) VALUES (
            $1, $2, $3, $4, $5, 0, 'SB',
            $6, $7, $8, 'C', $9,
            $10, 'system', $11
          )
        `, [
          transNo,
          tx.date,
          tx.type,
          tx.code,
          tx.mbno,
          tx.amount,
          `${tx.type}${String(transNo).padStart(3, '0')}`,
          tx.type === 'CR' ? 'R' : 'P',
          tx.amount,
          tx.narration,
          transNo
        ]);
        
        log(`✓ Created: ${tx.type} ₹${tx.amount} - ${tx.narration}`, 'green');
        transNo++;
        successCount++;
        
      } catch (error) {
        log(`✗ Failed: ${tx.narration} - ${error.message}`, 'red');
      }
    }
    
    log(`\n✅ Successfully created ${successCount} transactions for ${today}`, 'green');
    
    // Verify the data
    const verification = await pool.query(`
      SELECT 
        SUM(CASE WHEN trans_type = 'CR' THEN 
          CAST(REGEXP_REPLACE(trans_amt::text, '[^0-9.]', '', 'g') AS NUMERIC) 
          ELSE 0 END) as receipts,
        SUM(CASE WHEN trans_type = 'DR' THEN 
          CAST(REGEXP_REPLACE(trans_amt::text, '[^0-9.]', '', 'g') AS NUMERIC) 
          ELSE 0 END) as payments,
        COUNT(*) as total_transactions
      FROM transactions 
      WHERE DATE(trans_date) = $1
    `, [today]);
    
    const result = verification.rows[0];
    log(`\n📊 Today's Summary:`, 'cyan');
    log(`   Receipts: ₹${Number(result.receipts || 0).toLocaleString('en-IN')}`, 'green');
    log(`   Payments: ₹${Number(result.payments || 0).toLocaleString('en-IN')}`, 'red');
    log(`   Net: ₹${Number((result.receipts || 0) - (result.payments || 0)).toLocaleString('en-IN')}`, 'blue');
    log(`   Transactions: ${result.total_transactions}`, 'yellow');
    
    return true;
    
  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
    return false;
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  populateCashBookData()
    .then(success => {
      if (success) {
        console.log('\n🎉 CashBook sample data populated successfully!');
        console.log('Run: node test-cashbook-comprehensive.js to test');
      }
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { populateCashBookData };