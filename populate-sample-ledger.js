const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

async function populateSampleLedger() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Check if ledger table has data
    const existingResult = await client.query('SELECT COUNT(*) as count FROM ledger');
    const existingCount = parseInt(existingResult.rows[0].count);
    
    console.log(`Found ${existingCount} ledger entries`);

    if (existingCount > 0) {
      console.log('Ledger table already has data. Showing sample entries:');
      const sampleResult = await client.query(`
        SELECT trans_no, trans_date, mbno, code, trans_type, trans_amt, narration 
        FROM ledger 
        ORDER BY trans_date DESC 
        LIMIT 5
      `);
      
      sampleResult.rows.forEach(row => {
        console.log(`${row.trans_type} | ${row.trans_date} | Member: ${row.mbno} | Code: ${row.code} | Amount: ${row.trans_amt} | ${row.narration}`);
      });
      return;
    }

    // Create sample ledger entries based on existing transactions
    const transactionsResult = await client.query(`
      SELECT trans_no, trans_date, trans_type, mbno, code, trans_amt, narration, receipt_vchr_no, username
      FROM transactions 
      ORDER BY trans_date, trans_no
    `);

    console.log(`Creating ledger entries from ${transactionsResult.rows.length} transactions...`);

    let runningBalance = 0;
    for (const transaction of transactionsResult.rows) {
      const amount = parseFloat(transaction.trans_amt.toString().replace(/[$₹,?]/g, '').trim()) || 0;
      
      // Update running balance
      if (transaction.trans_type === 'CR') {
        runningBalance += amount;
      } else {
        runningBalance -= amount;
      }

      // Insert ledger entry
      await client.query(`
        INSERT INTO ledger (
          trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
          trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
          narration, username
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (trans_no) DO NOTHING
      `, [
        transaction.trans_no,
        transaction.trans_date,
        transaction.trans_type,
        transaction.code,
        transaction.mbno,
        0, // acc_no
        'SB', // acc_type
        amount,
        transaction.receipt_vchr_no,
        'R', // vchr_type
        'C', // modeofpay
        runningBalance,
        transaction.narration,
        transaction.username
      ]);
    }

    console.log('Sample ledger entries created successfully!');

    // Show summary
    const summaryResult = await client.query(`
      SELECT 
        mbno,
        code,
        COUNT(*) as transaction_count,
        SUM(CASE WHEN trans_type = 'CR' THEN CAST(REPLACE(REPLACE(trans_amt::text, '$', ''), ',', '') AS NUMERIC) ELSE 0 END) as total_credits,
        SUM(CASE WHEN trans_type = 'DR' THEN CAST(REPLACE(REPLACE(trans_amt::text, '$', ''), ',', '') AS NUMERIC) ELSE 0 END) as total_debits
      FROM ledger 
      GROUP BY mbno, code
      ORDER BY mbno, code
    `);

    console.log('\nLedger Summary by Member and Head:');
    console.log('Member | Head | Transactions | Credits | Debits');
    console.log('-------|------|--------------|---------|-------');
    summaryResult.rows.forEach(row => {
      console.log(`${row.mbno} | ${row.code} | ${row.transaction_count} | ₹${row.total_credits} | ₹${row.total_debits}`);
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

populateSampleLedger();