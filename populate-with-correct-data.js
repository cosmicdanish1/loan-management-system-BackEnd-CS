const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function populateWithCorrectData() {
  try {
    await client.connect();
    console.log('🔍 Populating tables with correct data types...\n');

    // Get existing member numbers
    const membersResult = await client.query('SELECT mbno, f_name, m_name, l_name FROM member_master LIMIT 10');
    const members = membersResult.rows;
    
    if (members.length === 0) {
      console.log('❌ No members found in member_master table');
      return;
    }
    
    console.log(`Found ${members.length} members`);

    // 1. Populate fdmaster with correct data types
    console.log('\n🔧 Populating fdmaster...');
    
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
        // Insert with correct data types - interestpayamentmode is integer NOT NULL
        await client.query(`
          INSERT INTO fdmaster (
            mbno, account_number, f_name, m_name, l_name, certno, 
            depunit, depperiod, rate, depdate, matdate, fdamount, 
            matamount, interestpayamentmode, interestamount, 
            status, fdrdflag, operationmode, intcalmethod
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `, [
          member.mbno, accountNo, member.f_name, member.m_name, member.l_name, certNo,
          1, 12, rate, depDate, matDate, amount, // depunit=1 (years), depperiod=12 (months)
          Math.round(amount * 1.075), 1, Math.round(amount * 0.075), // interestpayamentmode=1 (maturity)
          '0', fdType, 1, 1 // operationmode=1, intcalmethod=1
        ]);
        
        console.log(`✅ Inserted FD account ${accountNo} for member ${member.mbno} (${member.f_name})`);
      } catch (error) {
        console.log(`❌ Error inserting FD for member ${member.mbno}:`, error.message);
      }
    }

    // 2. Add ledger transactions with correct money type and pl_balance
    console.log('\n🔧 Adding ledger transactions...');
    
    // Get the current max ledger ID to avoid conflicts
    const maxLedgerResult = await client.query('SELECT COALESCE(MAX(ledgerid), 0) as max_id FROM ledger');
    let ledgerId = parseInt(maxLedgerResult.rows[0].max_id) + 1;
    
    for (let i = 0; i < Math.min(5, members.length); i++) {
      const member = members[i];
      const accountNo = 500001 + i;
      const amount = 50000 + (i * 25000);
      
      try {
        // Deposit transaction - pl_balance is required
        await client.query(`
          INSERT INTO ledger (
            ledgerid, trans_date, mbno, code, trans_type, trans_amt, 
            narration, receipt_vchr_no, acc_no, pl_balance
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          ledgerId++, `2024-0${(i % 9) + 1}-01`, member.mbno, 'FD', 'CR', amount,
          `FD Deposit ${accountNo}`, `V${String(i + 1).padStart(4, '0')}`, accountNo, amount
        ]);
        
        // Interest transaction
        const interestAmount = Math.round(amount * 0.075 / 12);
        await client.query(`
          INSERT INTO ledger (
            ledgerid, trans_date, mbno, code, trans_type, trans_amt, 
            narration, receipt_vchr_no, acc_no, pl_balance
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          ledgerId++, `2024-0${(i % 9) + 2}-01`, member.mbno, 'INT', 'CR', interestAmount,
          `Interest ${accountNo}`, `I${String(i + 1).padStart(4, '0')}`, accountNo, amount + interestAmount
        ]);
        
        console.log(`✅ Added transactions for member ${member.mbno}`);
      } catch (error) {
        console.log(`❌ Error adding transactions for member ${member.mbno}:`, error.message);
      }
    }

    // 3. Verify the data
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

    const newLedgerCount = await client.query(`SELECT COUNT(*) as count FROM ledger WHERE code IN ('FD', 'INT') AND trans_date >= '2024-01-01'`);
    console.log(`📊 New Ledger records: ${newLedgerCount.rows[0].count}`);

    // 4. Test our AdHoc Reports
    console.log('\n🧪 Testing AdHoc Reports...');
    
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
      accountTest.rows.forEach(record => {
        console.log(`  - ${record.memberNo}: ${record.memberName} - ${record.accountType} - ₹${record.amount}`);
      });

      // Test member-wise report
      const memberTest = await client.query(`
        SELECT 
          m.mbno as "memberNo",
          CONCAT(m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          COALESCE(a.cur_shareamt, 0)::numeric as "shareBalance",
          COALESCE(a.cur_triftamt, 0)::numeric as "cdBalance"
        FROM member_master m
        LEFT JOIN annualstatement a ON m.mbno = a.accno
        WHERE m.mbno IN (SELECT DISTINCT mbno FROM fdmaster)
        LIMIT 3
      `);
      
      console.log(`✅ Member-wise report: ${memberTest.rows.length} records`);
      memberTest.rows.forEach(record => {
        console.log(`  - ${record.memberNo}: ${record.memberName} - Share: ₹${record.shareBalance}, CD: ₹${record.cdBalance}`);
      });

    } catch (error) {
      console.log('❌ Error testing reports:', error.message);
    }

    console.log('\n✅ Database population completed successfully!');
    console.log('\n🎯 Now you can test:');
    console.log('  - AdHoc Reports with account_wise, member_wise, balance_summary');
    console.log('  - PassBook Printing with the populated member numbers');
    
  } catch (error) {
    console.error('Population error:', error);
  } finally {
    await client.end();
  }
}

populateWithCorrectData().catch(console.error);