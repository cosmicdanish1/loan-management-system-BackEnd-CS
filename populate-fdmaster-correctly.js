const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function populateFDMasterCorrectly() {
  try {
    await client.connect();
    console.log('🔍 Populating fdmaster with correct column structure...\n');

    // Get existing member numbers
    const membersResult = await client.query('SELECT mbno, f_name, m_name, l_name FROM member_master LIMIT 10');
    const members = membersResult.rows;
    
    if (members.length === 0) {
      console.log('❌ No members found in member_master table');
      return;
    }
    
    console.log(`Found ${members.length} members`);

    // Insert FD records with correct column names
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const accountNo = 500001 + i;
      const certNo = `FD${String(i + 1).padStart(4, '0')}`;
      const amount = 50000 + (i * 25000);
      const rate = 7.5 + (i * 0.1);
      const depDate = `2024-0${(i % 9) + 1}-01`;
      const matDate = `2025-0${(i % 9) + 1}-01`;
      const fdType = i % 2 === 0 ? 'F' : 'R';
      
      try {
        // Insert with actual column names from the table
        await client.query(`
          INSERT INTO fdmaster (
            mbno, account_number, f_name, m_name, l_name, certno, 
            depunit, depperiod, rate, depdate, matdate, fdamount, 
            matamount, interestpayamentmode, interestamount, 
            status, fdrdflag, operationmode, intcalmethod
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `, [
          member.mbno, accountNo, member.f_name, member.m_name, member.l_name, certNo,
          'YEAR', 1, rate, depDate, matDate, amount,
          Math.round(amount * 1.075), 'MATURITY', Math.round(amount * 0.075),
          '0', fdType, 'NORMAL', 'SIMPLE'
        ]);
        
        console.log(`✅ Inserted FD account ${accountNo} for member ${member.mbno} (${member.f_name})`);
      } catch (error) {
        console.log(`❌ Error inserting FD for member ${member.mbno}:`, error.message);
      }
    }

    // Add some ledger transactions with correct narration length
    console.log('\n🔧 Adding ledger transactions...');
    
    for (let i = 0; i < Math.min(5, members.length); i++) {
      const member = members[i];
      const accountNo = 500001 + i;
      const amount = 50000 + (i * 25000);
      
      try {
        // Deposit transaction with shorter narration
        await client.query(`
          INSERT INTO ledger (
            trans_date, mbno, code, trans_type, trans_amt, 
            narration, receipt_vchr_no, acc_no
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          `2024-0${(i % 9) + 1}-01`, member.mbno, 'FD', 'CR', amount,
          `FD${accountNo}`, `V${String(i + 1).padStart(4, '0')}`, accountNo
        ]);
        
        // Interest transaction
        const interestAmount = Math.round(amount * 0.075 / 12);
        await client.query(`
          INSERT INTO ledger (
            trans_date, mbno, code, trans_type, trans_amt, 
            narration, receipt_vchr_no, acc_no
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          `2024-0${(i % 9) + 2}-01`, member.mbno, 'INT', 'CR', interestAmount,
          `INT${accountNo}`, `I${String(i + 1).padStart(4, '0')}`, accountNo
        ]);
        
        console.log(`✅ Added transactions for member ${member.mbno}`);
      } catch (error) {
        console.log(`❌ Error adding transactions for member ${member.mbno}:`, error.message);
      }
    }

    // Verify the data
    console.log('\n🔍 Verifying populated data...');
    
    const fdCount = await client.query('SELECT COUNT(*) as count FROM fdmaster');
    console.log(`📊 FD Master records: ${fdCount.rows[0].count}`);
    
    if (parseInt(fdCount.rows[0].count) > 0) {
      const sampleFD = await client.query('SELECT mbno, account_number, certno, fdamount, fdrdflag FROM fdmaster LIMIT 3');
      console.log('📋 Sample FD records:');
      sampleFD.rows.forEach(fd => {
        console.log(`  - Member: ${fd.mbno}, Account: ${fd.account_number}, Cert: ${fd.certno}, Amount: ${fd.fdamount}, Type: ${fd.fdrdflag}`);
      });
    }

    // Test our reports
    console.log('\n🧪 Testing reports with new data...');
    
    try {
      // Test account-wise report
      const accountTest = await client.query(`
        SELECT 
          f.mbno as "memberNo",
          CONCAT(COALESCE(f.f_name, ''), ' ', COALESCE(f.m_name, ''), ' ', COALESCE(f.l_name, '')) as "memberName",
          f.account_number::text as "accountNo",
          f.certno as "certificateNo",
          CASE 
            WHEN f.fdrdflag = 'F' THEN 'Fixed Deposit'
            WHEN f.fdrdflag = 'R' THEN 'Recurring Deposit'
            ELSE 'Savings'
          END as "accountType",
          f.fdamount::numeric as "amount"
        FROM fdmaster f
        LIMIT 3
      `);
      
      console.log(`✅ Account-wise report: ${accountTest.rows.length} records`);
      if (accountTest.rows.length > 0) {
        accountTest.rows.forEach(record => {
          console.log(`  - ${record.memberNo}: ${record.memberName} - ${record.accountType} - ₹${record.amount}`);
        });
      }

      // Test passbook report
      const passbookTest = await client.query(`
        SELECT 
          m.mbno as "memberNo",
          CONCAT(m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          m.present_address as "address",
          m.memb_date as "membershipDate"
        FROM member_master m
        WHERE m.mbno IN (SELECT DISTINCT mbno FROM fdmaster)
        LIMIT 3
      `);
      
      console.log(`✅ PassBook member data: ${passbookTest.rows.length} records`);
      if (passbookTest.rows.length > 0) {
        passbookTest.rows.forEach(record => {
          console.log(`  - ${record.memberNo}: ${record.memberName}`);
        });
      }

    } catch (error) {
      console.log('❌ Error testing reports:', error.message);
    }

    console.log('\n✅ FD Master population completed successfully!');
    
  } catch (error) {
    console.error('Population error:', error);
  } finally {
    await client.end();
  }
}

populateFDMasterCorrectly().catch(console.error);