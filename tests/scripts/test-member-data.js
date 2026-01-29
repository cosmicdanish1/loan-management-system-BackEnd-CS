const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

async function testMemberData() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Check member_master table
    const memberResult = await client.query(`
      SELECT mbno, f_name, m_name, l_name 
      FROM member_master 
      ORDER BY mbno::numeric 
      LIMIT 10
    `);
    
    console.log('\nSample Members:');
    console.log('Member No | Name');
    console.log('----------|-----');
    memberResult.rows.forEach(row => {
      const fullName = `${row.f_name || ''} ${row.m_name || ''} ${row.l_name || ''}`.trim();
      console.log(`${row.mbno} | ${fullName}`);
    });

    // Check ledger table for sample member
    if (memberResult.rows.length > 0) {
      const sampleMember = memberResult.rows[0].mbno;
      console.log(`\nLedger entries for member ${sampleMember}:`);
      
      const ledgerResult = await client.query(`
        SELECT trans_date, code, trans_type, trans_amt, narration
        FROM ledger 
        WHERE mbno = $1
        ORDER BY trans_date DESC
        LIMIT 5
      `, [sampleMember]);
      
      console.log('Date | Code | Type | Amount | Narration');
      console.log('-----|------|------|--------|----------');
      ledgerResult.rows.forEach(row => {
        console.log(`${row.trans_date.toISOString().split('T')[0]} | ${row.code} | ${row.trans_type} | ${row.trans_amt} | ${row.narration}`);
      });

      // Check available head codes for this member
      const headResult = await client.query(`
        SELECT DISTINCT code 
        FROM ledger 
        WHERE mbno = $1
        ORDER BY code
      `, [sampleMember]);
      
      console.log(`\nAvailable head codes for member ${sampleMember}:`);
      headResult.rows.forEach(row => {
        console.log(`- ${row.code}`);
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

testMemberData();