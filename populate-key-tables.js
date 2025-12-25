const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function populateKeyTables() {
  try {
    await client.connect();
    console.log('🔍 Populating key tables for reports...\n');

    // 1. First, let's check what columns exist in fdmaster
    console.log('📋 Checking fdmaster table structure...');
    const fdColumns = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'fdmaster' 
      ORDER BY ordinal_position;
    `);
    
    console.log('FD Master columns:', fdColumns.rows.map(r => r.column_name).join(', '));

    // 2. Populate fdmaster with proper data
    console.log('\n🔧 Populating fdmaster table...');
    
    // Get existing member numbers from member_master
    const membersResult = await client.query('SELECT mbno FROM member_master LIMIT 10');
    const memberNumbers = membersResult.rows.map(row => row.mbno);
    
    if (memberNumbers.length === 0) {
      console.log('❌ No members found in member_master table');
      return;
    }
    
    console.log(`Found ${memberNumbers.length} members:`, memberNumbers.slice(0, 5));

    // Insert FD records for existing members
    for (let i = 0; i < Math.min(10, memberNumbers.length); i++) {
      const memberNo = memberNumbers[i];
      const accountNo = 500001 + i;
      const certNo = `FD${String(i + 1).padStart(6, '0')}`;
      const amount = 50000 + (i * 25000);
      const rate = 7.5 + (i * 0.1);
      const depDate = `2024-0${(i % 9) + 1}-01`;
      const matDate = `2025-0${(i % 9) + 1}-01`;
      const fdType = i % 2 === 0 ? 'F' : 'R';
      
      try {
        // Insert with minimal required fields
        await client.query(`
          INSERT INTO fdmaster (
            mbno, account_number, certno, fdamount, rate, 
            depdate, matdate, fdrdflag, status, period,
            interestpayamentmode, int_amt
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          memberNo, accountNo, certNo, amount, rate,
          depDate, matDate, fdType, '0', 12,
          'MATURITY', Math.round(amount * 0.075) // 7.5% interest
        ]);
        
        console.log(`✅ Inserted FD account ${accountNo} for member ${memberNo}`);
      } catch (error) {
        console.log(`❌ Error inserting FD for member ${memberNo}:`, error.message);
      }
    }

    // 3. Populate share_master if it exists and is empty
    console.log('\n🔧 Checking and populating share_master...');
    
    try {
      const shareCount = await client.query('SELECT COUNT(*) as count FROM share_master');
      if (parseInt(shareCount.rows[0].count) === 0) {
        console.log('Populating share_master...');
        
        for (let i = 0; i < Math.min(10, memberNumbers.length); i++) {
          const memberNo = memberNumbers[i];
          const certNo = `SH${String(i + 1).padStart(6, '0')}`;
          const shareFrom = (i * 50) + 1;
          const shareTo = (i + 1) * 50;
          
          try {
            await client.query(`
              INSERT INTO share_master (
                member_code, certificate_no, share_from, share_to, 
                no_of_shares, face_value, issue_date
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
              memberNo, certNo, shareFrom, shareTo, 
              50, 100, `2024-0${(i % 9) + 1}-01`
            ]);
            
            console.log(`✅ Inserted shares ${shareFrom}-${shareTo} for member ${memberNo}`);
          } catch (error) {
            console.log(`❌ Error inserting shares for member ${memberNo}:`, error.message);
          }
        }
      } else {
        console.log(`Share master already has ${shareCount.rows[0].count} records`);
      }
    } catch (error) {
      console.log('Share master table may not exist or has different structure');
    }

    // 4. Add some ledger transactions for the FD accounts
    console.log('\n🔧 Adding ledger transactions...');
    
    for (let i = 0; i < Math.min(5, memberNumbers.length); i++) {
      const memberNo = memberNumbers[i];
      const accountNo = 500001 + i;
      const amount = 50000 + (i * 25000);
      
      try {
        // Deposit transaction
        await client.query(`
          INSERT INTO ledger (
            trans_date, mbno, code, trans_type, trans_amt, 
            narration, receipt_vchr_no, acc_no
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          `2024-0${(i % 9) + 1}-01`, memberNo, 'DEPOSIT', 'CR', amount,
          `FD Deposit for account ${accountNo}`, `FD${i + 1}`, accountNo
        ]);
        
        // Interest transaction
        const interestAmount = Math.round(amount * 0.075 / 12); // Monthly interest
        await client.query(`
          INSERT INTO ledger (
            trans_date, mbno, code, trans_type, trans_amt, 
            narration, receipt_vchr_no, acc_no
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          `2024-0${(i % 9) + 2}-01`, memberNo, 'INTEREST', 'CR', interestAmount,
          `Interest credit for FD ${accountNo}`, `INT${i + 1}`, accountNo
        ]);
        
        console.log(`✅ Added transactions for member ${memberNo}, account ${accountNo}`);
      } catch (error) {
        console.log(`❌ Error adding transactions for member ${memberNo}:`, error.message);
      }
    }

    // 5. Verify the data
    console.log('\n🔍 Verifying populated data...');
    
    const fdCount = await client.query('SELECT COUNT(*) as count FROM fdmaster');
    console.log(`📊 FD Master records: ${fdCount.rows[0].count}`);
    
    const ledgerCount = await client.query('SELECT COUNT(*) as count FROM ledger WHERE code IN (\'DEPOSIT\', \'INTEREST\')');
    console.log(`📊 New Ledger records: ${ledgerCount.rows[0].count}`);
    
    const annualCount = await client.query('SELECT COUNT(*) as count FROM annualstatement');
    console.log(`📊 Annual Statement records: ${annualCount.rows[0].count}`);

    // 6. Test our AdHoc Reports with the new data
    console.log('\n🧪 Testing AdHoc Reports with new data...');
    
    try {
      const accountWiseTest = await client.query(`
        SELECT 
          f.mbno as "memberNo",
          CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          f.account_number::text as "accountNo",
          f.certno as "certificateNo",
          CASE 
            WHEN f.fdrdflag = 'F' THEN 'Fixed Deposit'
            WHEN f.fdrdflag = 'R' THEN 'Recurring Deposit'
            ELSE 'Savings'
          END as "accountType",
          f.fdamount::numeric as "amount"
        FROM fdmaster f
        INNER JOIN member_master m ON f.mbno = m.mbno
        LIMIT 5
      `);
      
      console.log(`✅ Account-wise report test: ${accountWiseTest.rows.length} records found`);
      if (accountWiseTest.rows.length > 0) {
        console.log('Sample record:', {
          memberNo: accountWiseTest.rows[0].memberNo,
          memberName: accountWiseTest.rows[0].memberName,
          accountNo: accountWiseTest.rows[0].accountNo,
          accountType: accountWiseTest.rows[0].accountType
        });
      }
    } catch (error) {
      console.log('❌ Error testing account-wise report:', error.message);
    }

    console.log('\n✅ Key tables population completed!');
    
  } catch (error) {
    console.error('Population error:', error);
  } finally {
    await client.end();
  }
}

populateKeyTables().catch(console.error);