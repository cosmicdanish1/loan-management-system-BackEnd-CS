const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

async function checkTable() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Check table structure
    const tableInfo = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'transactions'
      ORDER BY ordinal_position
    `);

    console.log('\nTransactions table structure:');
    console.log('Column | Type | Nullable | Default');
    console.log('-------|------|----------|--------');
    tableInfo.rows.forEach(row => {
      console.log(`${row.column_name} | ${row.data_type} | ${row.is_nullable} | ${row.column_default || 'NULL'}`);
    });

    // Check if there are any existing transactions
    const existingData = await client.query(`
      SELECT trans_no, trans_type, trans_date, code, narration, trans_amt::numeric as amount
      FROM transactions 
      ORDER BY trans_date DESC, trans_no DESC
      LIMIT 5
    `);

    console.log('\nExisting transactions (last 5):');
    if (existingData.rows.length > 0) {
      console.log('Trans No | Type | Date | Code | Amount | Narration');
      console.log('---------|------|------|------|--------|----------');
      existingData.rows.forEach(row => {
        console.log(`${row.trans_no} | ${row.trans_type} | ${row.trans_date.toISOString().split('T')[0]} | ${row.code} | ₹${row.amount} | ${row.narration}`);
      });
    } else {
      console.log('No transactions found');
    }

    // Check sequence
    const sequenceInfo = await client.query(`
      SELECT sequence_name, last_value, increment_by
      FROM information_schema.sequences 
      WHERE sequence_name LIKE '%transactions%'
    `);

    console.log('\nSequence information:');
    if (sequenceInfo.rows.length > 0) {
      sequenceInfo.rows.forEach(row => {
        console.log(`${row.sequence_name}: last_value=${row.last_value}, increment=${row.increment_by}`);
      });
    } else {
      console.log('No sequences found for transactions table');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

checkTable();