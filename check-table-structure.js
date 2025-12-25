const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function checkTableStructure() {
  try {
    await client.connect();
    console.log('🔍 Checking table structures...\n');

    // Check fdmaster structure
    console.log('📋 FDMASTER table structure:');
    const fdColumns = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
      FROM information_schema.columns 
      WHERE table_name = 'fdmaster' 
      ORDER BY ordinal_position;
    `);
    
    fdColumns.rows.forEach(col => {
      console.log(`  ${col.column_name}: ${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ''} ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${col.column_default ? `DEFAULT ${col.column_default}` : ''}`);
    });

    // Check ledger structure
    console.log('\n📋 LEDGER table structure:');
    const ledgerColumns = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
      FROM information_schema.columns 
      WHERE table_name = 'ledger' 
      ORDER BY ordinal_position;
    `);
    
    ledgerColumns.rows.forEach(col => {
      console.log(`  ${col.column_name}: ${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ''} ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${col.column_default ? `DEFAULT ${col.column_default}` : ''}`);
    });

    // Check existing data patterns
    console.log('\n📋 Existing data patterns:');
    
    // Check existing fdmaster records if any
    const existingFD = await client.query('SELECT * FROM fdmaster LIMIT 1');
    if (existingFD.rows.length > 0) {
      console.log('Sample FD record:', existingFD.rows[0]);
    } else {
      console.log('No existing FD records');
    }

    // Check existing ledger records
    const existingLedger = await client.query('SELECT * FROM ledger LIMIT 3');
    if (existingLedger.rows.length > 0) {
      console.log('Sample Ledger records:');
      existingLedger.rows.forEach((record, index) => {
        console.log(`  ${index + 1}:`, {
          trans_date: record.trans_date,
          mbno: record.mbno,
          code: record.code,
          trans_type: record.trans_type,
          trans_amt: record.trans_amt,
          pl_balance: record.pl_balance
        });
      });
    }

    // Check member_master sample
    console.log('\n📋 Sample member data:');
    const sampleMember = await client.query('SELECT mbno, f_name, m_name, l_name, present_address FROM member_master LIMIT 3');
    sampleMember.rows.forEach(member => {
      console.log(`  ${member.mbno}: ${member.f_name} ${member.m_name || ''} ${member.l_name || ''}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

checkTableStructure().catch(console.error);