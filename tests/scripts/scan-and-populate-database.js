const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function scanAllTables() {
  try {
    await client.connect();
    console.log('🔍 Scanning all database tables...\n');

    // Get all tables in the database
    const tablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;
    
    const tablesResult = await client.query(tablesQuery);
    const tables = tablesResult.rows.map(row => row.table_name);
    
    console.log(`Found ${tables.length} tables:`);
    
    const emptyTables = [];
    
    for (const table of tables) {
      try {
        const countResult = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
        const count = parseInt(countResult.rows[0].count);
        
        console.log(`📊 ${table}: ${count} records`);
        
        if (count === 0) {
          emptyTables.push(table);
        }
      } catch (error) {
        console.log(`❌ ${table}: Error reading (${error.message})`);
      }
    }
    
    console.log(`\n🔍 Found ${emptyTables.length} empty tables:`);
    emptyTables.forEach(table => console.log(`  - ${table}`));
    
    return { allTables: tables, emptyTables };
    
  } catch (error) {
    console.error('Database scan error:', error);
    throw error;
  }
}

async function getTableStructure(tableName) {
  try {
    const structureQuery = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = $1 
      ORDER BY ordinal_position;
    `;
    
    const result = await client.query(structureQuery, [tableName]);
    return result.rows;
  } catch (error) {
    console.error(`Error getting structure for ${tableName}:`, error);
    return [];
  }
}

async function populateTable(tableName, columns) {
  console.log(`\n🔧 Populating ${tableName}...`);
  
  try {
    // Define sample data generators based on table name and column patterns
    const sampleData = generateSampleData(tableName, columns);
    
    if (sampleData.length === 0) {
      console.log(`⚠️  No sample data generator for ${tableName}`);
      return;
    }
    
    // Insert sample data
    for (let i = 0; i < sampleData.length; i++) {
      const record = sampleData[i];
      const columnNames = Object.keys(record);
      const values = Object.values(record);
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
      
      const insertQuery = `
        INSERT INTO ${tableName} (${columnNames.join(', ')}) 
        VALUES (${placeholders})
      `;
      
      try {
        await client.query(insertQuery, values);
      } catch (error) {
        console.log(`❌ Error inserting record ${i + 1}: ${error.message}`);
      }
    }
    
    console.log(`✅ Inserted ${sampleData.length} records into ${tableName}`);
    
  } catch (error) {
    console.error(`Error populating ${tableName}:`, error);
  }
}

function generateSampleData(tableName, columns) {
  const columnNames = columns.map(col => col.column_name);
  
  switch (tableName.toLowerCase()) {
    case 'member_master':
    case 'members':
      return generateMemberData(columnNames);
    
    case 'fdmaster':
      return generateFDData(columnNames);
    
    case 'loan_master':
      return generateLoanData(columnNames);
    
    case 'headmaster':
      return generateHeadMasterData(columnNames);
    
    case 'ledger':
      return generateLedgerData(columnNames);
    
    case 'annualstatement':
      return generateAnnualStatementData(columnNames);
    
    case 'share_master':
      return generateShareMasterData(columnNames);
    
    case 'cashbook':
      return generateCashBookData(columnNames);
    
    case 'daybook':
      return generateDayBookData(columnNames);
    
    default:
      return [];
  }
}

function generateMemberData(columns) {
  const members = [];
  const baseMembers = [
    { prefix: 'Mr.', fname: 'Rajesh', mname: 'Kumar', lname: 'Sharma', desig: 'Manager', dept: 'Finance' },
    { prefix: 'Ms.', fname: 'Priya', mname: 'Devi', lname: 'Patel', desig: 'Assistant', dept: 'HR' },
    { prefix: 'Mr.', fname: 'Amit', mname: 'Singh', lname: 'Gupta', desig: 'Officer', dept: 'Operations' },
    { prefix: 'Mrs.', fname: 'Sunita', mname: 'Rani', lname: 'Verma', desig: 'Clerk', dept: 'Accounts' },
    { prefix: 'Mr.', fname: 'Vikash', mname: 'Chandra', lname: 'Yadav', desig: 'Executive', dept: 'Sales' },
    { prefix: 'Ms.', fname: 'Kavita', mname: 'Kumari', lname: 'Singh', desig: 'Analyst', dept: 'IT' },
    { prefix: 'Mr.', fname: 'Deepak', mname: 'Kumar', lname: 'Jha', desig: 'Supervisor', dept: 'Production' },
    { prefix: 'Mrs.', fname: 'Meera', mname: 'Devi', lname: 'Agarwal', desig: 'Coordinator', dept: 'Admin' },
    { prefix: 'Mr.', fname: 'Suresh', mname: 'Babu', lname: 'Reddy', desig: 'Engineer', dept: 'Technical' },
    { prefix: 'Ms.', fname: 'Anita', mname: 'Kumari', lname: 'Mishra', desig: 'Associate', dept: 'Marketing' }
  ];
  
  for (let i = 0; i < 10; i++) {
    const member = baseMembers[i];
    const memberNo = 1000001 + i;
    const record = {};
    
    // Map common column names
    if (columns.includes('mbno')) record.mbno = memberNo;
    if (columns.includes('member_no')) record.member_no = memberNo;
    if (columns.includes('prefix')) record.prefix = member.prefix;
    if (columns.includes('f_name')) record.f_name = member.fname;
    if (columns.includes('m_name')) record.m_name = member.mname;
    if (columns.includes('l_name')) record.l_name = member.lname;
    if (columns.includes('desig')) record.desig = member.desig;
    if (columns.includes('dept_name')) record.dept_name = member.dept;
    if (columns.includes('present_address')) record.present_address = `${i + 1}/123, Sector ${i + 10}, New Delhi - 11000${i}`;
    if (columns.includes('memb_date')) record.memb_date = `2020-0${(i % 9) + 1}-15`;
    if (columns.includes('isactive')) record.isactive = 'Y';
    if (columns.includes('flg_retire')) record.flg_retire = 'N';
    if (columns.includes('basic_pay')) record.basic_pay = 25000 + (i * 5000);
    if (columns.includes('officeno')) record.officeno = i + 1;
    if (columns.includes('wingno')) record.wingno = `WING-${String.fromCharCode(65 + (i % 5))}`;
    
    members.push(record);
  }
  
  return members;
}

function generateFDData(columns) {
  const fdAccounts = [];
  
  for (let i = 0; i < 10; i++) {
    const memberNo = 1000001 + i;
    const record = {};
    
    if (columns.includes('mbno')) record.mbno = memberNo;
    if (columns.includes('account_number')) record.account_number = 500001 + i;
    if (columns.includes('certno')) record.certno = `FD${String(i + 1).padStart(6, '0')}`;
    if (columns.includes('fdamount')) record.fdamount = 50000 + (i * 25000);
    if (columns.includes('rate')) record.rate = 7.5 + (i * 0.1);
    if (columns.includes('depdate')) record.depdate = `2024-0${(i % 9) + 1}-01`;
    if (columns.includes('matdate')) record.matdate = `2025-0${(i % 9) + 1}-01`;
    if (columns.includes('fdrdflag')) record.fdrdflag = i % 2 === 0 ? 'F' : 'R';
    if (columns.includes('status')) record.status = '0'; // Active
    if (columns.includes('period')) record.period = 12;
    if (columns.includes('int_amt')) record.int_amt = Math.round((record.fdamount || 50000) * 0.075);
    
    fdAccounts.push(record);
  }
  
  return fdAccounts;
}

function generateLoanData(columns) {
  const loans = [];
  const loanTypes = ['PERSONAL', 'HOME', 'VEHICLE', 'EDUCATION', 'EMERGENCY'];
  
  for (let i = 0; i < 10; i++) {
    const memberNo = 1000001 + i;
    const record = {};
    
    if (columns.includes('mbno')) record.mbno = memberNo;
    if (columns.includes('loancaseno')) record.loancaseno = `LN${String(i + 1).padStart(6, '0')}`;
    if (columns.includes('loantype')) record.loantype = loanTypes[i % loanTypes.length];
    if (columns.includes('loan_amt')) record.loan_amt = 100000 + (i * 50000);
    if (columns.includes('balance')) record.balance = (100000 + (i * 50000)) * 0.7; // 70% remaining
    if (columns.includes('rate')) record.rate = 10.5 + (i * 0.2);
    if (columns.includes('instal_amt')) record.instal_amt = Math.round((record.loan_amt || 100000) / 60); // 5 year EMI
    if (columns.includes('no_of_instal')) record.no_of_instal = 60;
    if (columns.includes('payment_date')) record.payment_date = `2024-0${(i % 9) + 1}-15`;
    if (columns.includes('purpose')) record.purpose = `${record.loantype} loan for member ${memberNo}`;
    if (columns.includes('status')) record.status = 'ACTIVE';
    
    loans.push(record);
  }
  
  return loans;
}

function generateHeadMasterData(columns) {
  const heads = [
    { code: 'CASH', name: 'Cash in Hand', type: 'ASSET' },
    { code: 'BANK', name: 'Bank Account', type: 'ASSET' },
    { code: 'SHARE', name: 'Share Capital', type: 'EQUITY' },
    { code: 'DEPOSIT', name: 'Member Deposits', type: 'LIABILITY' },
    { code: 'LOAN', name: 'Loans to Members', type: 'ASSET' },
    { code: 'INTEREST', name: 'Interest Income', type: 'INCOME' },
    { code: 'EXPENSE', name: 'Operating Expenses', type: 'EXPENSE' },
    { code: 'RESERVE', name: 'Reserve Fund', type: 'EQUITY' },
    { code: 'DIVIDEND', name: 'Dividend Payable', type: 'LIABILITY' },
    { code: 'MISC', name: 'Miscellaneous', type: 'EXPENSE' }
  ];
  
  return heads.map(head => {
    const record = {};
    if (columns.includes('code')) record.code = head.code;
    if (columns.includes('head_name')) record.head_name = head.name;
    if (columns.includes('headtype')) record.headtype = head.type;
    if (columns.includes('isactive')) record.isactive = 'Y';
    return record;
  });
}

function generateLedgerData(columns) {
  const transactions = [];
  
  for (let i = 0; i < 10; i++) {
    const memberNo = 1000001 + (i % 10);
    const record = {};
    
    if (columns.includes('trans_no')) record.trans_no = i + 1;
    if (columns.includes('trans_date')) record.trans_date = `2024-${String((i % 12) + 1).padStart(2, '0')}-15`;
    if (columns.includes('mbno')) record.mbno = memberNo;
    if (columns.includes('code')) record.code = ['CASH', 'BANK', 'DEPOSIT', 'LOAN'][i % 4];
    if (columns.includes('trans_type')) record.trans_type = i % 2 === 0 ? 'DR' : 'CR';
    if (columns.includes('trans_amt')) record.trans_amt = 5000 + (i * 1000);
    if (columns.includes('narration')) record.narration = `Transaction ${i + 1} for member ${memberNo}`;
    if (columns.includes('receipt_vchr_no')) record.receipt_vchr_no = `V${String(i + 1).padStart(4, '0')}`;
    if (columns.includes('acc_no')) record.acc_no = 500001 + (i % 10);
    
    transactions.push(record);
  }
  
  return transactions;
}

function generateAnnualStatementData(columns) {
  const statements = [];
  
  for (let i = 0; i < 10; i++) {
    const memberNo = 1000001 + i;
    const record = {};
    
    if (columns.includes('accno')) record.accno = memberNo;
    if (columns.includes('cur_shareamt')) record.cur_shareamt = 10000 + (i * 2000);
    if (columns.includes('cur_triftamt')) record.cur_triftamt = 25000 + (i * 5000);
    if (columns.includes('cur_tfintrec')) record.cur_tfintrec = 15000 + (i * 3000);
    if (columns.includes('year')) record.year = 2024;
    
    statements.push(record);
  }
  
  return statements;
}

function generateShareMasterData(columns) {
  const shares = [];
  
  for (let i = 0; i < 10; i++) {
    const memberNo = 1000001 + i;
    const record = {};
    
    if (columns.includes('member_code')) record.member_code = memberNo;
    if (columns.includes('certificate_no')) record.certificate_no = `SH${String(i + 1).padStart(6, '0')}`;
    if (columns.includes('share_from')) record.share_from = (i * 50) + 1;
    if (columns.includes('share_to')) record.share_to = (i + 1) * 50;
    if (columns.includes('no_of_shares')) record.no_of_shares = 50;
    if (columns.includes('face_value')) record.face_value = 100;
    if (columns.includes('issue_date')) record.issue_date = `2024-0${(i % 9) + 1}-01`;
    
    shares.push(record);
  }
  
  return shares;
}

function generateCashBookData(columns) {
  const cashbook = [];
  
  for (let i = 0; i < 10; i++) {
    const record = {};
    
    if (columns.includes('trans_date')) record.trans_date = `2024-${String((i % 12) + 1).padStart(2, '0')}-15`;
    if (columns.includes('headcode')) record.headcode = ['CASH', 'BANK', 'DEPOSIT'][i % 3];
    if (columns.includes('headname')) record.headname = ['Cash in Hand', 'Bank Account', 'Member Deposits'][i % 3];
    if (columns.includes('rcash')) record.rcash = i % 2 === 0 ? 5000 + (i * 1000) : 0;
    if (columns.includes('pcash')) record.pcash = i % 2 === 1 ? 3000 + (i * 500) : 0;
    if (columns.includes('rtransfer')) record.rtransfer = 0;
    if (columns.includes('ptransfer')) record.ptransfer = 0;
    
    cashbook.push(record);
  }
  
  return cashbook;
}

function generateDayBookData(columns) {
  const daybook = [];
  
  for (let i = 0; i < 10; i++) {
    const memberNo = 1000001 + (i % 10);
    const record = {};
    
    if (columns.includes('trans_date')) record.trans_date = `2024-${String((i % 12) + 1).padStart(2, '0')}-15`;
    if (columns.includes('member_code')) record.member_code = memberNo;
    if (columns.includes('trans_type')) record.trans_type = i % 2 === 0 ? 'DEPOSIT' : 'WITHDRAWAL';
    if (columns.includes('amount')) record.amount = 2000 + (i * 500);
    if (columns.includes('narration')) record.narration = `${record.trans_type} by member ${memberNo}`;
    if (columns.includes('voucher_no')) record.voucher_no = `DB${String(i + 1).padStart(4, '0')}`;
    
    daybook.push(record);
  }
  
  return daybook;
}

async function main() {
  try {
    const { allTables, emptyTables } = await scanAllTables();
    
    if (emptyTables.length === 0) {
      console.log('\n✅ All tables have data. No population needed.');
      return;
    }
    
    console.log('\n🚀 Starting population of empty tables...');
    
    for (const tableName of emptyTables) {
      const columns = await getTableStructure(tableName);
      if (columns.length > 0) {
        await populateTable(tableName, columns);
      }
    }
    
    console.log('\n✅ Database population completed!');
    
    // Verify population
    console.log('\n🔍 Verifying population...');
    for (const tableName of emptyTables) {
      try {
        const countResult = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
        const count = parseInt(countResult.rows[0].count);
        console.log(`📊 ${tableName}: ${count} records`);
      } catch (error) {
        console.log(`❌ ${tableName}: Error verifying (${error.message})`);
      }
    }
    
  } catch (error) {
    console.error('Main execution error:', error);
  } finally {
    await client.end();
  }
}

main().catch(console.error);