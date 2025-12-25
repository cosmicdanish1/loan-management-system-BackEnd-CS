const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function completeTablePopulation() {
  try {
    await client.connect();
    console.log('🔍 Complete Database Table Population and Verification...\n');

    // Step 1: Get all tables and their current counts
    const allTables = await getAllTablesWithCounts();
    
    // Step 2: Identify empty tables
    const emptyTables = allTables.filter(table => table.count === 0);
    const partialTables = allTables.filter(table => table.count > 0 && table.count < 10);
    
    console.log(`📊 Database Summary:`);
    console.log(`   Total Tables: ${allTables.length}`);
    console.log(`   Empty Tables: ${emptyTables.length}`);
    console.log(`   Partially Filled: ${partialTables.length}`);
    console.log(`   Well Populated: ${allTables.length - emptyTables.length - partialTables.length}\n`);

    // Step 3: Get existing reference data
    const referenceData = await getReferenceData();
    
    // Step 4: Populate all empty and partial tables
    console.log('🚀 Starting comprehensive population...\n');
    
    for (const table of [...emptyTables, ...partialTables]) {
      await populateTable(table.name, referenceData);
    }
    
    // Step 5: Final verification
    console.log('\n🔍 Final Verification...');
    await finalVerification();
    
    console.log('\n✅ Complete database population finished!');
    
  } catch (error) {
    console.error('Population error:', error);
  } finally {
    await client.end();
  }
}

async function getAllTablesWithCounts() {
  const tablesQuery = `
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;
  
  const tablesResult = await client.query(tablesQuery);
  const tables = [];
  
  for (const row of tablesResult.rows) {
    try {
      const countResult = await client.query(`SELECT COUNT(*) as count FROM ${row.table_name}`);
      tables.push({
        name: row.table_name,
        count: parseInt(countResult.rows[0].count)
      });
    } catch (error) {
      tables.push({
        name: row.table_name,
        count: -1,
        error: error.message
      });
    }
  }
  
  return tables;
}

async function getReferenceData() {
  console.log('📋 Gathering reference data...');
  
  const data = {
    members: [],
    wings: [],
    heads: [],
    loans: [],
    fdAccounts: []
  };
  
  try {
    // Get sample members
    const membersResult = await client.query('SELECT mbno, f_name, m_name, l_name, wingno, officeno FROM member_master LIMIT 20');
    data.members = membersResult.rows;
    
    // Get wings
    const wingsResult = await client.query('SELECT wingno, wname FROM wingmast LIMIT 10');
    data.wings = wingsResult.rows;
    
    // Get head codes
    const headsResult = await client.query('SELECT code, head_name FROM headmaster LIMIT 20');
    data.heads = headsResult.rows;
    
    // Get loans
    const loansResult = await client.query('SELECT mbno, loancaseno, loantype, loan_amt FROM loan_master LIMIT 10');
    data.loans = loansResult.rows;
    
    // Get FD accounts
    const fdResult = await client.query('SELECT mbno, account_number, fdamount FROM fdmaster LIMIT 10');
    data.fdAccounts = fdResult.rows;
    
    console.log(`   Members: ${data.members.length}, Wings: ${data.wings.length}, Heads: ${data.heads.length}`);
    
  } catch (error) {
    console.log(`   Warning: Error gathering reference data: ${error.message}`);
  }
  
  return data;
}

async function populateTable(tableName, referenceData) {
  console.log(`🔧 Populating ${tableName}...`);
  
  try {
    // Get table structure
    const columns = await getTableColumns(tableName);
    
    // Generate data based on table name and structure
    const sampleData = generateTableData(tableName, columns, referenceData);
    
    if (sampleData.length === 0) {
      console.log(`   ⚠️  No data generator for ${tableName}`);
      return;
    }
    
    // Insert data
    let insertedCount = 0;
    for (const record of sampleData) {
      try {
        const columnNames = Object.keys(record);
        const values = Object.values(record);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        
        const insertQuery = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders})`;
        await client.query(insertQuery, values);
        insertedCount++;
      } catch (error) {
        // Skip individual record errors but continue
        if (insertedCount === 0) {
          console.log(`   ❌ Error inserting into ${tableName}: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} records`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error populating ${tableName}: ${error.message}`);
  }
}

async function getTableColumns(tableName) {
  const query = `
    SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
    FROM information_schema.columns 
    WHERE table_name = $1 
    ORDER BY ordinal_position;
  `;
  
  const result = await client.query(query, [tableName]);
  return result.rows;
}

function generateTableData(tableName, columns, referenceData) {
  const columnNames = columns.map(col => col.column_name);
  
  switch (tableName.toLowerCase()) {
    // Master Tables
    case 'relation_master':
      return generateRelationMaster();
    case 'wingmast':
      return generateWingMaster();
    case 'division_master':
      return generateDivisionMaster(referenceData.wings);
    case 'membertypemaster':
      return generateMemberTypeMaster();
    case 'castcategorymaster':
      return generateCastCategoryMaster();
    
    // Financial Tables
    case 'interestmaster':
      return generateInterestMaster();
    case 'fdrd_slab_details':
      return generateFDRDSlabDetails();
    case 'fd_interest_master':
      return generateFDInterestMaster(referenceData.fdAccounts);
    case 'interestpaid':
      return generateInterestPaid(referenceData.members);
    
    // Account Tables
    case 'fdmaster':
      return generateFDMaster(referenceData.members, columnNames);
    case 'fdmasterhistory':
      return generateFDMasterHistory(referenceData.fdAccounts);
    case 'fdrdlienmaster':
      return generateFDRDLienMaster(referenceData.members, referenceData.fdAccounts);
    
    // Transaction Tables
    case 'voucher_master':
      return generateVoucherMaster();
    case 'transactions':
      return generateTransactions(referenceData.members, referenceData.heads);
    case 'daily_gl_history':
      return generateDailyGLHistory(referenceData.heads);
    
    // Loan Tables
    case 'loan_accounts':
      return generateLoanAccounts(referenceData.members);
    case 'loan_payments':
      return generateLoanPayments(referenceData.loans);
    case 'loan_interest_master':
      return generateLoanInterestMaster();
    case 'loan_limit_master':
      return generateLoanLimitMaster();
    
    // Member Tables
    case 'members':
      return generateMembers(columnNames);
    case 'member_data':
      return generateMemberData(referenceData.members);
    case 'member_transfer':
      return generateMemberTransfer(referenceData.members);
    case 'convertmember':
      return generateConvertMember(referenceData.members);
    
    // Deposit Tables
    case 'deposit_slabs':
      return generateDepositSlabs();
    case 'recurring_deposits':
      return generateRecurringDeposits(referenceData.members);
    case 'fixed_deposits':
      return generateFixedDeposits(referenceData.members);
    case 'rd_installments':
      return generateRDInstallments(referenceData.members);
    
    // System Tables
    case 'system_configs':
      return generateSystemConfigs(columnNames);
    case 'user_activities':
      return generateUserActivities(columnNames);
    case 'users':
      return generateUsers(columnNames);
    
    // Bank Tables
    case 'bank_saving_product':
      return generateBankSavingProduct();
    case 'bank_saving_detail_product':
      return generateBankSavingDetailProduct();
    case 'bank_sbintcalverify':
      return generateBankSBIntCalVerify();
    case 'bank_passbook_full':
      return generateBankPassbookFull();
    case 'bank_passbooksetting':
      return generateBankPassbookSetting();
    
    // Other Tables
    case 'guarrenter_mast':
      return generateGuarrenterMast(referenceData.members);
    case 'jointmaster':
      return generateJointMaster(referenceData.members);
    case 'designation_master':
      return generateDesignationMaster();
    case 'trf_slab':
      return generateTrfSlab();
    case 'yearend':
      return generateYearEnd();
    case 'yearend_head':
      return generateYearEndHead(referenceData.heads);
    case 'yearend_member':
      return generateYearEndMember(referenceData.members);
    
    default:
      return [];
  }
}

// Data generators for each table type
function generateRelationMaster() {
  return [
    { relation_id: 1, relation_name: 'Father' },
    { relation_id: 2, relation_name: 'Mother' },
    { relation_id: 3, relation_name: 'Spouse' },
    { relation_id: 4, relation_name: 'Son' },
    { relation_id: 5, relation_name: 'Daughter' },
    { relation_id: 6, relation_name: 'Brother' },
    { relation_id: 7, relation_name: 'Sister' },
    { relation_id: 8, relation_name: 'Uncle' },
    { relation_id: 9, relation_name: 'Aunt' },
    { relation_id: 10, relation_name: 'Grandfather' }
  ];
}

function generateWingMaster() {
  return [
    { wingno: 'WING-A', wname: 'Administrative Wing', winstate: 1 },
    { wingno: 'WING-B', wname: 'Finance Wing', winstate: 1 },
    { wingno: 'WING-C', wname: 'Operations Wing', winstate: 1 },
    { wingno: 'WING-D', wname: 'Technical Wing', winstate: 1 },
    { wingno: 'WING-E', wname: 'HR Wing', winstate: 1 },
    { wingno: 'WING-F', wname: 'Marketing Wing', winstate: 1 },
    { wingno: 'WING-G', wname: 'Legal Wing', winstate: 1 },
    { wingno: 'WING-H', wname: 'Audit Wing', winstate: 1 },
    { wingno: 'WING-I', wname: 'IT Wing', winstate: 1 },
    { wingno: 'WING-J', wname: 'Security Wing', winstate: 1 }
  ];
}

function generateDivisionMaster(wings) {
  const divisions = [];
  for (let i = 0; i < Math.min(10, wings.length); i++) {
    const wing = wings[i] || { wingno: `WING-${String.fromCharCode(65 + i)}` };
    divisions.push({
      wingno: wing.wingno,
      divno: i + 1,
      name: `Division ${i + 1} - ${wing.wingno}`,
      address: `${i + 1}/123, Sector ${i + 10}, Business District`,
      city: 'NAGPUR'
    });
  }
  return divisions;
}

function generateMemberTypeMaster() {
  return [
    { membertype: 'Regular Member' },
    { membertype: 'Associate Member' },
    { membertype: 'Honorary Member' },
    { membertype: 'Life Member' },
    { membertype: 'Temporary Member' },
    { membertype: 'Corporate Member' },
    { membertype: 'Student Member' },
    { membertype: 'Senior Citizen Member' },
    { membertype: 'Ex-Employee Member' },
    { membertype: 'Special Category Member' }
  ];
}

function generateCastCategoryMaster() {
  return [
    { castcategory: 'General' },
    { castcategory: 'OBC (Other Backward Class)' },
    { castcategory: 'SC (Scheduled Caste)' },
    { castcategory: 'ST (Scheduled Tribe)' },
    { castcategory: 'EWS (Economically Weaker Section)' },
    { castcategory: 'Minority' },
    { castcategory: 'PH (Physically Handicapped)' },
    { castcategory: 'Ex-Serviceman' },
    { castcategory: 'Freedom Fighter' },
    { castcategory: 'Sports Quota' }
  ];
}

function generateInterestMaster() {
  return [
    { inttype: 'FD', frdt: '2024-01-01', todt: '2024-12-31', rate: 7.50 },
    { inttype: 'RD', frdt: '2024-01-01', todt: '2024-12-31', rate: 6.50 },
    { inttype: 'SB', frdt: '2024-01-01', todt: '2024-12-31', rate: 4.00 },
    { inttype: 'LN', frdt: '2024-01-01', todt: '2024-12-31', rate: 10.50 },
    { inttype: 'PEN', frdt: '2024-01-01', todt: '2024-12-31', rate: 2.00 },
    { inttype: 'FD', frdt: '2023-01-01', todt: '2023-12-31', rate: 7.25 },
    { inttype: 'RD', frdt: '2023-01-01', todt: '2023-12-31', rate: 6.25 },
    { inttype: 'SB', frdt: '2023-01-01', todt: '2023-12-31', rate: 3.75 },
    { inttype: 'LN', frdt: '2023-01-01', todt: '2023-12-31', rate: 10.25 },
    { inttype: 'PEN', frdt: '2023-01-01', todt: '2023-12-31', rate: 1.75 }
  ];
}

function generateFDRDSlabDetails() {
  return [
    { fdrd: 'FD', scheme_code: 'FD01', from_amount: 10000, upto_amount: 50000, from_period: 12, upto_period: 24, period_unit: 'M', interest_rate: 7.50, premature_interest_rate: 6.50, applicable_from_date: '2024-01-01' },
    { fdrd: 'FD', scheme_code: 'FD02', from_amount: 50001, upto_amount: 100000, from_period: 12, upto_period: 36, period_unit: 'M', interest_rate: 7.75, premature_interest_rate: 6.75, applicable_from_date: '2024-01-01' },
    { fdrd: 'FD', scheme_code: 'FD03', from_amount: 100001, upto_amount: 500000, from_period: 24, upto_period: 60, period_unit: 'M', interest_rate: 8.00, premature_interest_rate: 7.00, applicable_from_date: '2024-01-01' },
    { fdrd: 'RD', scheme_code: 'RD01', from_amount: 500, upto_amount: 5000, from_period: 12, upto_period: 60, period_unit: 'M', interest_rate: 6.50, premature_interest_rate: 5.50, applicable_from_date: '2024-01-01' },
    { fdrd: 'RD', scheme_code: 'RD02', from_amount: 5001, upto_amount: 25000, from_period: 12, upto_period: 120, period_unit: 'M', interest_rate: 6.75, premature_interest_rate: 5.75, applicable_from_date: '2024-01-01' },
    { fdrd: 'FD', scheme_code: 'FD04', from_amount: 500001, upto_amount: 1000000, from_period: 36, upto_period: 120, period_unit: 'M', interest_rate: 8.25, premature_interest_rate: 7.25, applicable_from_date: '2024-01-01' },
    { fdrd: 'RD', scheme_code: 'RD03', from_amount: 25001, upto_amount: 100000, from_period: 24, upto_period: 240, period_unit: 'M', interest_rate: 7.00, premature_interest_rate: 6.00, applicable_from_date: '2024-01-01' },
    { fdrd: 'FD', scheme_code: 'FD05', from_amount: 1000001, upto_amount: 5000000, from_period: 60, upto_period: 240, period_unit: 'M', interest_rate: 8.50, premature_interest_rate: 7.50, applicable_from_date: '2024-01-01' },
    { fdrd: 'RD', scheme_code: 'RD04', from_amount: 100001, upto_amount: 500000, from_period: 36, upto_period: 360, period_unit: 'M', interest_rate: 7.25, premature_interest_rate: 6.25, applicable_from_date: '2024-01-01' },
    { fdrd: 'FD', scheme_code: 'FD06', from_amount: 5000001, upto_amount: 10000000, from_period: 120, upto_period: 360, period_unit: 'M', interest_rate: 8.75, premature_interest_rate: 7.75, applicable_from_date: '2024-01-01' }
  ];
}

function generateVoucherMaster() {
  return [
    { p_vchr_no: 'P00001', r_vchr_no: 'R00001', j_vchr_no: 'J00001', d_vchr_no: 'D00001' }
  ];
}

function generateFDMaster(members, columnNames) {
  const fdRecords = [];
  for (let i = 0; i < Math.min(15, members.length); i++) {
    const member = members[i];
    const record = {};
    
    if (columnNames.includes('mbno')) record.mbno = member.mbno;
    if (columnNames.includes('f_name')) record.f_name = member.f_name;
    if (columnNames.includes('m_name')) record.m_name = member.m_name;
    if (columnNames.includes('l_name')) record.l_name = member.l_name;
    if (columnNames.includes('certno')) record.certno = `FD${String(i + 1).padStart(4, '0')}`;
    if (columnNames.includes('depunit')) record.depunit = 1;
    if (columnNames.includes('depperiod')) record.depperiod = 12 + (i % 48);
    if (columnNames.includes('rate')) record.rate = 7.5 + (i * 0.1);
    if (columnNames.includes('depdate')) record.depdate = `2024-0${(i % 9) + 1}-01`;
    if (columnNames.includes('matdate')) record.matdate = `2025-0${(i % 9) + 1}-01`;
    if (columnNames.includes('fdamount')) record.fdamount = 25000 + (i * 15000);
    if (columnNames.includes('matamount')) record.matamount = Math.round((25000 + (i * 15000)) * 1.075);
    if (columnNames.includes('interestpayamentmode')) record.interestpayamentmode = 1;
    if (columnNames.includes('interestamount')) record.interestamount = Math.round((25000 + (i * 15000)) * 0.075);
    if (columnNames.includes('status')) record.status = '0';
    if (columnNames.includes('fdrdflag')) record.fdrdflag = i % 3 === 0 ? 'F' : (i % 3 === 1 ? 'R' : 'S');
    if (columnNames.includes('operationmode')) record.operationmode = 1;
    if (columnNames.includes('intcalmethod')) record.intcalmethod = 1;
    
    fdRecords.push(record);
  }
  return fdRecords;
}

function generateMembers(columnNames) {
  const members = [];
  const sampleMembers = [
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
    const member = sampleMembers[i];
    const memberNo = 700000001 + i;
    const record = {};
    
    if (columnNames.includes('mbno')) record.mbno = memberNo;
    if (columnNames.includes('member_no')) record.member_no = memberNo;
    if (columnNames.includes('prefix')) record.prefix = member.prefix;
    if (columnNames.includes('f_name')) record.f_name = member.fname;
    if (columnNames.includes('m_name')) record.m_name = member.mname;
    if (columnNames.includes('l_name')) record.l_name = member.lname;
    if (columnNames.includes('name')) record.name = `${member.fname} ${member.mname} ${member.lname}`;
    if (columnNames.includes('desig')) record.desig = member.desig;
    if (columnNames.includes('dept_name')) record.dept_name = member.dept;
    if (columnNames.includes('present_address')) record.present_address = `${i + 1}/123, Sector ${i + 10}, New Delhi - 11000${i}`;
    if (columnNames.includes('memb_date')) record.memb_date = `2020-0${(i % 9) + 1}-15`;
    if (columnNames.includes('isactive')) record.isactive = 'Y';
    if (columnNames.includes('flg_retire')) record.flg_retire = 'N';
    if (columnNames.includes('basic_pay')) record.basic_pay = 25000 + (i * 5000);
    if (columnNames.includes('officeno')) record.officeno = i + 1;
    if (columnNames.includes('wingno')) record.wingno = `WING-${String.fromCharCode(65 + (i % 5))}`;
    
    members.push(record);
  }
  
  return members;
}

// Add more generators for other tables...
function generateDepositSlabs() {
  return [
    { slab_id: 1, deposit_type: 'FD', min_amount: 10000, max_amount: 50000, min_period: 12, max_period: 24, interest_rate: 7.50 },
    { slab_id: 2, deposit_type: 'FD', min_amount: 50001, max_amount: 100000, min_period: 12, max_period: 36, interest_rate: 7.75 },
    { slab_id: 3, deposit_type: 'FD', min_amount: 100001, max_amount: 500000, min_period: 24, max_period: 60, interest_rate: 8.00 },
    { slab_id: 4, deposit_type: 'RD', min_amount: 500, max_amount: 5000, min_period: 12, max_period: 60, interest_rate: 6.50 },
    { slab_id: 5, deposit_type: 'RD', min_amount: 5001, max_amount: 25000, min_period: 12, max_period: 120, interest_rate: 6.75 },
    { slab_id: 6, deposit_type: 'SB', min_amount: 1000, max_amount: 100000, min_period: 0, max_period: 0, interest_rate: 4.00 },
    { slab_id: 7, deposit_type: 'FD', min_amount: 500001, max_amount: 1000000, min_period: 36, max_period: 120, interest_rate: 8.25 },
    { slab_id: 8, deposit_type: 'RD', min_amount: 25001, max_amount: 100000, min_period: 24, max_period: 240, interest_rate: 7.00 },
    { slab_id: 9, deposit_type: 'FD', min_amount: 1000001, max_amount: 5000000, min_period: 60, max_period: 240, interest_rate: 8.50 },
    { slab_id: 10, deposit_type: 'SB', min_amount: 100001, max_amount: 1000000, min_period: 0, max_period: 0, interest_rate: 4.25 }
  ];
}

function generateDesignationMaster() {
  return [
    { designation_id: 1, designation_name: 'Manager', department: 'Administration' },
    { designation_id: 2, designation_name: 'Assistant Manager', department: 'Finance' },
    { designation_id: 3, designation_name: 'Officer', department: 'Operations' },
    { designation_id: 4, designation_name: 'Assistant Officer', department: 'HR' },
    { designation_id: 5, designation_name: 'Clerk', department: 'Accounts' },
    { designation_id: 6, designation_name: 'Senior Clerk', department: 'Administration' },
    { designation_id: 7, designation_name: 'Executive', department: 'Marketing' },
    { designation_id: 8, designation_name: 'Senior Executive', department: 'Sales' },
    { designation_id: 9, designation_name: 'Analyst', department: 'IT' },
    { designation_id: 10, designation_name: 'Senior Analyst', department: 'Finance' }
  ];
}

// Simplified generators for other tables
function generateSystemConfigs(columnNames) {
  const configs = [
    { key: 'APP_NAME', value: 'Employee Cooperative Society', description: 'Application Name' },
    { key: 'APP_VERSION', value: '2.0.0', description: 'Application Version' },
    { key: 'DB_VERSION', value: '1.5.0', description: 'Database Version' },
    { key: 'BACKUP_RETENTION_DAYS', value: '30', description: 'Backup Retention Period' },
    { key: 'SESSION_TIMEOUT', value: '30', description: 'Session Timeout in Minutes' }
  ];
  
  return configs.map(config => {
    const record = {};
    if (columnNames.includes('config_key')) record.config_key = config.key;
    if (columnNames.includes('key')) record.key = config.key;
    if (columnNames.includes('config_value')) record.config_value = config.value;
    if (columnNames.includes('value')) record.value = config.value;
    if (columnNames.includes('description')) record.description = config.description;
    return record;
  });
}

function generateUserActivities(columnNames) {
  const activities = [
    { user_id: 1, activity: 'Login', timestamp: '2024-01-15 09:00:00', ip_address: '192.168.1.100' },
    { user_id: 1, activity: 'Member Registration', timestamp: '2024-01-15 09:30:00', ip_address: '192.168.1.100' },
    { user_id: 2, activity: 'FD Account Opening', timestamp: '2024-01-15 10:00:00', ip_address: '192.168.1.101' },
    { user_id: 2, activity: 'Interest Calculation', timestamp: '2024-01-15 11:00:00', ip_address: '192.168.1.101' },
    { user_id: 3, activity: 'Report Generation', timestamp: '2024-01-15 14:00:00', ip_address: '192.168.1.102' }
  ];
  
  return activities.map(activity => {
    const record = {};
    if (columnNames.includes('user_id')) record.user_id = activity.user_id;
    if (columnNames.includes('activity')) record.activity = activity.activity;
    if (columnNames.includes('activity_timestamp')) record.activity_timestamp = activity.timestamp;
    if (columnNames.includes('timestamp')) record.timestamp = activity.timestamp;
    if (columnNames.includes('ip_address')) record.ip_address = activity.ip_address;
    return record;
  });
}

function generateUsers(columnNames) {
  const users = [
    { username: 'admin', email: 'admin@society.com', role: 'Administrator', status: 'Active' },
    { username: 'manager', email: 'manager@society.com', role: 'Manager', status: 'Active' },
    { username: 'clerk', email: 'clerk@society.com', role: 'Clerk', status: 'Active' },
    { username: 'officer', email: 'officer@society.com', role: 'Officer', status: 'Active' },
    { username: 'cashier', email: 'cashier@society.com', role: 'Cashier', status: 'Active' }
  ];
  
  return users.map((user, index) => {
    const record = {};
    if (columnNames.includes('user_id')) record.user_id = index + 1;
    if (columnNames.includes('username')) record.username = user.username;
    if (columnNames.includes('email')) record.email = user.email;
    if (columnNames.includes('role')) record.role = user.role;
    if (columnNames.includes('status')) record.status = user.status;
    if (columnNames.includes('created_at')) record.created_at = '2024-01-01';
    return record;
  });
}

// Add placeholder generators for remaining tables
function generateFDInterestMaster(fdAccounts) { return []; }
function generateInterestPaid(members) { return []; }
function generateFDMasterHistory(fdAccounts) { return []; }
function generateFDRDLienMaster(members, fdAccounts) { return []; }
function generateTransactions(members, heads) { return []; }
function generateDailyGLHistory(heads) { return []; }
function generateLoanAccounts(members) { return []; }
function generateLoanPayments(loans) { return []; }
function generateLoanInterestMaster() { return []; }
function generateLoanLimitMaster() { return []; }
function generateMemberData(members) { return []; }
function generateMemberTransfer(members) { return []; }
function generateConvertMember(members) { return []; }
function generateRecurringDeposits(members) { return []; }
function generateFixedDeposits(members) { return []; }
function generateRDInstallments(members) { return []; }
function generateBankSavingProduct() { return []; }
function generateBankSavingDetailProduct() { return []; }
function generateBankSBIntCalVerify() { return []; }
function generateBankPassbookFull() { return []; }
function generateBankPassbookSetting() { return []; }
function generateGuarrenterMast(members) { return []; }
function generateJointMaster(members) { return []; }
function generateTrfSlab() { return []; }
function generateYearEnd() { return []; }
function generateYearEndHead(heads) { return []; }
function generateYearEndMember(members) { return []; }

async function finalVerification() {
  const allTables = await getAllTablesWithCounts();
  
  console.log('\n📊 Final Database Status:');
  console.log('=' .repeat(60));
  
  let emptyCount = 0;
  let populatedCount = 0;
  let errorCount = 0;
  
  for (const table of allTables) {
    if (table.count === -1) {
      console.log(`❌ ${table.name}: ERROR (${table.error})`);
      errorCount++;
    } else if (table.count === 0) {
      console.log(`⚪ ${table.name}: EMPTY`);
      emptyCount++;
    } else if (table.count < 10) {
      console.log(`🟡 ${table.name}: ${table.count} records (partial)`);
      populatedCount++;
    } else {
      console.log(`✅ ${table.name}: ${table.count} records`);
      populatedCount++;
    }
  }
  
  console.log('=' .repeat(60));
  console.log(`📈 Summary: ${populatedCount} populated, ${emptyCount} empty, ${errorCount} errors`);
  console.log(`📊 Total Tables: ${allTables.length}`);
  console.log(`🎯 Population Success Rate: ${Math.round((populatedCount / allTables.length) * 100)}%`);
}

completeTablePopulation().catch(console.error);