const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

async function populateSampleData() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Check if member_master has data
    const memberCount = await client.query('SELECT COUNT(*) as count FROM member_master');
    console.log(`Found ${memberCount.rows[0].count} members in member_master`);

    // Insert sample members if none exist
    if (parseInt(memberCount.rows[0].count) === 0) {
      console.log('Creating sample members...');
      
      const sampleMembers = [
        { mbno: '100001', f_name: 'John', m_name: 'A', l_name: 'Doe', desig: 'Manager' },
        { mbno: '100002', f_name: 'Jane', m_name: 'B', l_name: 'Smith', desig: 'Assistant' },
        { mbno: '100003', f_name: 'Robert', m_name: 'C', l_name: 'Johnson', desig: 'Clerk' },
        { mbno: '100004', f_name: 'Mary', m_name: 'D', l_name: 'Williams', desig: 'Officer' },
        { mbno: '100005', f_name: 'David', m_name: 'E', l_name: 'Brown', desig: 'Supervisor' }
      ];

      for (const member of sampleMembers) {
        await client.query(`
          INSERT INTO member_master (
            mbno, prefix, f_name, m_name, l_name, sex, desig, 
            present_address, permanent_address, wingno, officeno, 
            age, gross_salary, basic_pay, flg_retire, isactive
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (mbno) DO NOTHING
        `, [
          member.mbno, 'Mr', member.f_name, member.m_name, member.l_name, 'M', member.desig,
          '123 Main Street', '123 Main Street', '001', 1, 
          '35', 50000, 30000, 'N', 'Y'
        ]);
      }
      console.log('Sample members created');
    }

    // Check if headmaster has data
    const headCount = await client.query('SELECT COUNT(*) as count FROM headmaster');
    console.log(`Found ${headCount.rows[0].count} heads in headmaster`);

    // Insert sample head masters if none exist
    if (parseInt(headCount.rows[0].count) === 0) {
      console.log('Creating sample head masters...');
      
      const sampleHeads = [
        { code: 'A1001', head_name: 'CASH IN HAND', headtype: 'CASH' },
        { code: 'A1002', head_name: 'SAVINGS BANK ACCOUNT', headtype: 'BANK' },
        { code: 'L1001', head_name: 'REGULAR LOAN ACCOUNT', headtype: 'LOAN' },
        { code: 'L1002', head_name: 'EMERGENCY LOAN ACCOUNT', headtype: 'LOAN' },
        { code: 'I1001', head_name: 'INTEREST INCOME', headtype: 'INCO' },
        { code: 'E1001', head_name: 'OFFICE EXPENSES', headtype: 'EXPE' }
      ];

      for (const head of sampleHeads) {
        await client.query(`
          INSERT INTO headmaster (code, head_name, headtype, parent_code, hposition, interest, op_bal, pflag)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (code) DO NOTHING
        `, [
          head.code, head.head_name, head.headtype, '', '', 'N', 0, ''
        ]);
      }
      console.log('Sample head masters created');
    }

    // Check if ledger has data
    const ledgerCount = await client.query('SELECT COUNT(*) as count FROM ledger');
    console.log(`Found ${ledgerCount.rows[0].count} entries in ledger`);

    // Create sample ledger entries
    if (parseInt(ledgerCount.rows[0].count) === 0) {
      console.log('Creating sample ledger entries...');
      
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
      
      let transNo = 1;
      const sampleEntries = [
        // Member 100001 - Savings transactions
        { mbno: '100001', code: 'A1002', type: 'CR', amount: 5000, date: lastMonth, narration: 'Opening deposit' },
        { mbno: '100001', code: 'A1002', type: 'CR', amount: 2000, date: new Date(lastMonth.getTime() + 5*24*60*60*1000), narration: 'Monthly deposit' },
        { mbno: '100001', code: 'A1002', type: 'DR', amount: 500, date: new Date(lastMonth.getTime() + 10*24*60*60*1000), narration: 'Withdrawal' },
        { mbno: '100001', code: 'I1001', type: 'CR', amount: 150, date: new Date(lastMonth.getTime() + 15*24*60*60*1000), narration: 'Interest credit' },
        
        // Member 100002 - Loan transactions
        { mbno: '100002', code: 'L1001', type: 'CR', amount: 25000, date: lastMonth, narration: 'Loan disbursement' },
        { mbno: '100002', code: 'L1001', type: 'DR', amount: 1200, date: new Date(lastMonth.getTime() + 7*24*60*60*1000), narration: 'EMI payment' },
        { mbno: '100002', code: 'L1001', type: 'DR', amount: 1200, date: new Date(lastMonth.getTime() + 14*24*60*60*1000), narration: 'EMI payment' },
        
        // Member 100003 - Mixed transactions
        { mbno: '100003', code: 'A1002', type: 'CR', amount: 3000, date: lastMonth, narration: 'Initial deposit' },
        { mbno: '100003', code: 'L1002', type: 'CR', amount: 5000, date: new Date(lastMonth.getTime() + 3*24*60*60*1000), narration: 'Emergency loan' },
        { mbno: '100003', code: 'L1002', type: 'DR', amount: 500, date: new Date(lastMonth.getTime() + 12*24*60*60*1000), narration: 'Loan repayment' }
      ];

      for (const entry of sampleEntries) {
        await client.query(`
          INSERT INTO ledger (
            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
            narration, username
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
          transNo++, entry.date, entry.type, entry.code, entry.mbno, 0, 'SB',
          entry.amount, `V${transNo}`, 'R', 'C', 0, entry.narration, 'admin'
        ]);
      }
      console.log('Sample ledger entries created');
    }

    // Show summary
    console.log('\n=== SAMPLE DATA SUMMARY ===');
    
    const members = await client.query(`
      SELECT mbno, f_name, m_name, l_name 
      FROM member_master 
      ORDER BY mbno::numeric 
      LIMIT 5
    `);
    
    console.log('\nMembers:');
    members.rows.forEach(row => {
      const fullName = `${row.f_name} ${row.m_name} ${row.l_name}`;
      console.log(`- ${row.mbno}: ${fullName}`);
    });

    const heads = await client.query(`
      SELECT code, head_name 
      FROM headmaster 
      ORDER BY code 
      LIMIT 6
    `);
    
    console.log('\nHead Masters:');
    heads.rows.forEach(row => {
      console.log(`- ${row.code}: ${row.head_name}`);
    });

    const ledgerSummary = await client.query(`
      SELECT mbno, code, COUNT(*) as transactions
      FROM ledger 
      GROUP BY mbno, code
      ORDER BY mbno, code
    `);
    
    console.log('\nLedger Summary:');
    ledgerSummary.rows.forEach(row => {
      console.log(`- Member ${row.mbno}, Head ${row.code}: ${row.transactions} transactions`);
    });

    console.log('\n✅ Sample data ready for testing!');
    console.log('\nTest with:');
    console.log('- Member Number: 100001');
    console.log('- Head Code: A1002 (Savings Bank Account)');
    console.log('- Date Range: Last month to today');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

populateSampleData();