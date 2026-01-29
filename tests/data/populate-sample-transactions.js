const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

async function checkAndPopulateTransactions() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Check if transactions table exists and has data
    const checkResult = await client.query(`
      SELECT COUNT(*) as count 
      FROM transactions 
      WHERE trans_date >= CURRENT_DATE - INTERVAL '30 days'
    `);
    
    const existingCount = parseInt(checkResult.rows[0].count);
    console.log(`Found ${existingCount} transactions in the last 30 days`);

    if (existingCount < 10) {
      console.log('No recent transactions found. Populating with sample data...');
      
      // Get the next transaction number
      const maxResult = await client.query('SELECT COALESCE(MAX(trans_no), 0) as max_trans_no FROM transactions');
      let nextTransNo = parseInt(maxResult.rows[0].max_trans_no) + 1;
      
      // Insert sample transactions for today and recent dates
      const sampleTransactions = [
        // Today's transactions
        {
          trans_no: nextTransNo++,
          trans_type: 'CR',
          trans_date: new Date(),
          mbno: 12345,
          acc_no: 1001,
          acc_type: 'SB',
          trans_amt: '5000.00',
          receipt_vchr_no: 'R001',
          vchr_type: 'R',
          modeofpay: 'C',
          code: 'A1001',
          narration: 'Cash deposit - Savings Account',
          username: 'admin'
        },
        {
          trans_no: nextTransNo++,
          trans_type: 'DR',
          trans_date: new Date(),
          mbno: 12346,
          acc_no: 1002,
          acc_type: 'SB',
          trans_amt: '2000.00',
          receipt_vchr_no: 'P001',
          vchr_type: 'P',
          modeofpay: 'C',
          code: 'A1001',
          narration: 'Cash withdrawal - Savings Account',
          username: 'admin'
        },
        {
          trans_no: nextTransNo++,
          trans_type: 'CR',
          trans_date: new Date(),
          mbno: 12347,
          acc_no: 1003,
          acc_type: 'FD',
          trans_amt: '10000.00',
          receipt_vchr_no: 'R002',
          vchr_type: 'R',
          modeofpay: 'C',
          code: 'A1002',
          narration: 'Fixed deposit opening',
          username: 'admin'
        },
        {
          trans_no: nextTransNo++,
          trans_type: 'CR',
          trans_date: new Date(),
          mbno: 12348,
          acc_no: 1004,
          acc_type: 'RD',
          trans_amt: '1000.00',
          receipt_vchr_no: 'R003',
          vchr_type: 'R',
          modeofpay: 'C',
          code: 'A1003',
          narration: 'Recurring deposit installment',
          username: 'admin'
        },
        {
          trans_no: nextTransNo++,
          trans_type: 'DR',
          trans_date: new Date(),
          mbno: 0,
          acc_no: 0,
          acc_type: 'EXP',
          trans_amt: '500.00',
          receipt_vchr_no: 'P002',
          vchr_type: 'P',
          modeofpay: 'C',
          code: 'E4002',
          narration: 'Office expenses',
          username: 'admin'
        },
        // Yesterday's transactions
        {
          trans_no: nextTransNo++,
          trans_type: 'CR',
          trans_date: new Date(Date.now() - 24 * 60 * 60 * 1000),
          mbno: 12349,
          acc_no: 1005,
          acc_type: 'SB',
          trans_amt: '3000.00',
          receipt_vchr_no: 'R004',
          vchr_type: 'R',
          modeofpay: 'C',
          code: 'A1001',
          narration: 'Cash deposit - Previous day',
          username: 'admin'
        },
        {
          trans_no: nextTransNo++,
          trans_type: 'DR',
          trans_date: new Date(Date.now() - 24 * 60 * 60 * 1000),
          mbno: 12350,
          acc_no: 1006,
          acc_type: 'SB',
          trans_amt: '1500.00',
          receipt_vchr_no: 'P003',
          vchr_type: 'P',
          modeofpay: 'C',
          code: 'A1001',
          narration: 'Cash withdrawal - Previous day',
          username: 'admin'
        }
      ];

      for (const transaction of sampleTransactions) {
        await client.query(`
          INSERT INTO transactions (
            trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt,
            receipt_vchr_no, vchr_type, modeofpay, code, narration, username,
            cheq_no, cheq_amt, bankname, pass_flag, cashier_flag
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '', '0.00', '', 'N', 'N')
        `, [
          transaction.trans_no,
          transaction.trans_type,
          transaction.trans_date,
          transaction.mbno,
          transaction.acc_no,
          transaction.acc_type,
          transaction.trans_amt,
          transaction.receipt_vchr_no,
          transaction.vchr_type,
          transaction.modeofpay,
          transaction.code,
          transaction.narration,
          transaction.username
        ]);
      }

      console.log(`Inserted ${sampleTransactions.length} sample transactions`);
    }

    // Verify the data
    const verifyResult = await client.query(`
      SELECT 
        trans_type,
        DATE(trans_date) as trans_date,
        code,
        narration,
        trans_amt::numeric as trans_amt,
        COUNT(*) as count
      FROM transactions 
      WHERE trans_date >= CURRENT_DATE - INTERVAL '2 days'
      GROUP BY trans_type, DATE(trans_date), code, narration, trans_amt
      ORDER BY trans_date DESC, trans_type, code
    `);

    console.log('\nCurrent transactions in database:');
    console.log('Type | Date | Code | Amount | Narration');
    console.log('-----|------|------|--------|----------');
    verifyResult.rows.forEach(row => {
      console.log(`${row.trans_type} | ${row.trans_date} | ${row.code} | ₹${row.trans_amt} | ${row.narration}`);
    });

    // Check today's summary
    const todayResult = await client.query(`
      SELECT 
        SUM(CASE WHEN trans_type = 'CR' THEN trans_amt::numeric ELSE 0 END) as total_receipts,
        SUM(CASE WHEN trans_type = 'DR' THEN trans_amt::numeric ELSE 0 END) as total_payments,
        COUNT(*) as total_transactions
      FROM transactions 
      WHERE DATE(trans_date) = CURRENT_DATE
    `);

    const todaySummary = todayResult.rows[0];
    console.log('\nToday\'s Summary:');
    console.log(`Total Receipts: ₹${todaySummary.total_receipts || 0}`);
    console.log(`Total Payments: ₹${todaySummary.total_payments || 0}`);
    console.log(`Total Transactions: ${todaySummary.total_transactions}`);
    console.log(`Net Balance: ₹${(todaySummary.total_receipts || 0) - (todaySummary.total_payments || 0)}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

checkAndPopulateTransactions();