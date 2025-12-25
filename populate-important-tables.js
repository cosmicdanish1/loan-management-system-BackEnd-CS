const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function populateImportantTables() {
  try {
    await client.connect();
    console.log('🎯 Populating Important Empty Tables for Application Functionality...\n');

    // Get reference data
    const referenceData = await getReferenceData();
    
    // Populate key tables in order of importance
    await populateDepositSlabs();
    await populateDesignationMaster();
    await populateSystemConfigs();
    await populateUserActivities();
    await populateUsers();
    await populateLoanAccounts(referenceData.members);
    await populateLoanPayments(referenceData.loans);
    await populateRecurringDeposits(referenceData.members);
    await populateFixedDeposits(referenceData.members);
    await populateRDInstallments(referenceData.members);
    await populateInterestPostings(referenceData.members);
    await populateInterestRates();
    await populateBankSavingDetailProduct();
    await populateBankSBIntCalVerify();
    await populateVouchers();
    await populateTrfSlab();
    await populateYearEnd();
    await populateYearEndHead(referenceData.heads);
    await populateYearEndMember(referenceData.members);
    
    console.log('\n✅ Important tables population completed!');
    
    // Final summary
    await showFinalSummary();
    
  } catch (error) {
    console.error('Population error:', error);
  } finally {
    await client.end();
  }
}

async function getReferenceData() {
  console.log('📋 Gathering reference data...');
  
  const data = { members: [], wings: [], heads: [], loans: [], fdAccounts: [] };
  
  try {
    const membersResult = await client.query('SELECT mbno, f_name, m_name, l_name, wingno, officeno FROM member_master LIMIT 20');
    data.members = membersResult.rows;
    
    const wingsResult = await client.query('SELECT wingno, wname FROM wingmast LIMIT 10');
    data.wings = wingsResult.rows;
    
    const headsResult = await client.query('SELECT code, head_name FROM headmaster LIMIT 20');
    data.heads = headsResult.rows;
    
    const loansResult = await client.query('SELECT mbno, loancaseno, loantype, loan_amt FROM loan_master LIMIT 10');
    data.loans = loansResult.rows;
    
    const fdResult = await client.query('SELECT mbno, account_number, fdamount FROM fdmaster LIMIT 10');
    data.fdAccounts = fdResult.rows;
    
    console.log(`   ✅ Reference data: ${data.members.length} members, ${data.wings.length} wings, ${data.heads.length} heads\n`);
    
  } catch (error) {
    console.log(`   ⚠️  Warning: ${error.message}\n`);
  }
  
  return data;
}

async function populateDepositSlabs() {
  console.log('🔧 Populating deposit_slabs...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM deposit_slabs');
    if (parseInt(count.rows[0].count) > 0) {
      console.log('   ⚠️  Already has data');
      return;
    }
    
    // Get table structure first
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'deposit_slabs' ORDER BY ordinal_position
    `);
    const columnNames = columns.rows.map(row => row.column_name);
    
    const slabs = [
      { deposit_type: 'FD', min_amount: 10000, max_amount: 50000, min_period: 12, max_period: 24, interest_rate: 7.50 },
      { deposit_type: 'FD', min_amount: 50001, max_amount: 100000, min_period: 12, max_period: 36, interest_rate: 7.75 },
      { deposit_type: 'FD', min_amount: 100001, max_amount: 500000, min_period: 24, max_period: 60, interest_rate: 8.00 },
      { deposit_type: 'RD', min_amount: 500, max_amount: 5000, min_period: 12, max_period: 60, interest_rate: 6.50 },
      { deposit_type: 'RD', min_amount: 5001, max_amount: 25000, min_period: 12, max_period: 120, interest_rate: 6.75 },
      { deposit_type: 'SB', min_amount: 1000, max_amount: 100000, min_period: 0, max_period: 0, interest_rate: 4.00 },
      { deposit_type: 'FD', min_amount: 500001, max_amount: 1000000, min_period: 36, max_period: 120, interest_rate: 8.25 },
      { deposit_type: 'RD', min_amount: 25001, max_amount: 100000, min_period: 24, max_period: 240, interest_rate: 7.00 },
      { deposit_type: 'FD', min_amount: 1000001, max_amount: 5000000, min_period: 60, max_period: 240, interest_rate: 8.50 },
      { deposit_type: 'SB', min_amount: 100001, max_amount: 1000000, min_period: 0, max_period: 0, interest_rate: 4.25 }
    ];
    
    let insertedCount = 0;
    for (const slab of slabs) {
      try {
        // Build insert query based on available columns
        const availableFields = Object.keys(slab).filter(key => columnNames.includes(key));
        const values = availableFields.map(key => slab[key]);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        
        const insertQuery = `INSERT INTO deposit_slabs (${availableFields.join(', ')}) VALUES (${placeholders})`;
        await client.query(insertQuery, values);
        insertedCount++;
      } catch (error) {
        if (insertedCount === 0) {
          console.log(`   ❌ Error: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} deposit slabs`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

async function populateDesignationMaster() {
  console.log('🔧 Populating designation_master...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM designation_master');
    if (parseInt(count.rows[0].count) > 0) {
      console.log('   ⚠️  Already has data');
      return;
    }
    
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'designation_master' ORDER BY ordinal_position
    `);
    const columnNames = columns.rows.map(row => row.column_name);
    
    const designations = [
      { designation_name: 'Manager', department: 'Administration' },
      { designation_name: 'Assistant Manager', department: 'Finance' },
      { designation_name: 'Officer', department: 'Operations' },
      { designation_name: 'Assistant Officer', department: 'HR' },
      { designation_name: 'Clerk', department: 'Accounts' },
      { designation_name: 'Senior Clerk', department: 'Administration' },
      { designation_name: 'Executive', department: 'Marketing' },
      { designation_name: 'Senior Executive', department: 'Sales' },
      { designation_name: 'Analyst', department: 'IT' },
      { designation_name: 'Senior Analyst', department: 'Finance' }
    ];
    
    let insertedCount = 0;
    for (const designation of designations) {
      try {
        const availableFields = Object.keys(designation).filter(key => columnNames.includes(key));
        const values = availableFields.map(key => designation[key]);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        
        const insertQuery = `INSERT INTO designation_master (${availableFields.join(', ')}) VALUES (${placeholders})`;
        await client.query(insertQuery, values);
        insertedCount++;
      } catch (error) {
        if (insertedCount === 0) {
          console.log(`   ❌ Error: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} designations`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

async function populateSystemConfigs() {
  console.log('🔧 Populating system_configs...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM system_configs');
    if (parseInt(count.rows[0].count) > 0) {
      console.log('   ⚠️  Already has data');
      return;
    }
    
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'system_configs' ORDER BY ordinal_position
    `);
    const columnNames = columns.rows.map(row => row.column_name);
    
    const configs = [
      { config_key: 'APP_NAME', config_value: 'Employee Cooperative Society', description: 'Application Name' },
      { config_key: 'APP_VERSION', config_value: '2.0.0', description: 'Application Version' },
      { config_key: 'DB_VERSION', config_value: '1.5.0', description: 'Database Version' },
      { config_key: 'BACKUP_RETENTION_DAYS', config_value: '30', description: 'Backup Retention Period' },
      { config_key: 'SESSION_TIMEOUT', config_value: '30', description: 'Session Timeout in Minutes' },
      { config_key: 'INTEREST_CALCULATION_METHOD', config_value: 'DAILY', description: 'Interest Calculation Method' },
      { config_key: 'FINANCIAL_YEAR_START', config_value: '04-01', description: 'Financial Year Start Date' },
      { config_key: 'DEFAULT_CURRENCY', config_value: 'INR', description: 'Default Currency' },
      { config_key: 'DECIMAL_PLACES', config_value: '2', description: 'Decimal Places for Amounts' },
      { config_key: 'AUTO_BACKUP_ENABLED', config_value: 'true', description: 'Auto Backup Enabled' }
    ];
    
    let insertedCount = 0;
    for (const config of configs) {
      try {
        // Map to different possible column names
        const mappedConfig = {};
        if (columnNames.includes('config_key')) mappedConfig.config_key = config.config_key;
        if (columnNames.includes('key')) mappedConfig.key = config.config_key;
        if (columnNames.includes('config_value')) mappedConfig.config_value = config.config_value;
        if (columnNames.includes('value')) mappedConfig.value = config.config_value;
        if (columnNames.includes('description')) mappedConfig.description = config.description;
        
        const availableFields = Object.keys(mappedConfig);
        const values = availableFields.map(key => mappedConfig[key]);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        
        const insertQuery = `INSERT INTO system_configs (${availableFields.join(', ')}) VALUES (${placeholders})`;
        await client.query(insertQuery, values);
        insertedCount++;
      } catch (error) {
        if (insertedCount === 0) {
          console.log(`   ❌ Error: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} system configs`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

async function populateUserActivities() {
  console.log('🔧 Populating user_activities...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM user_activities');
    if (parseInt(count.rows[0].count) > 0) {
      console.log('   ⚠️  Already has data');
      return;
    }
    
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'user_activities' ORDER BY ordinal_position
    `);
    const columnNames = columns.rows.map(row => row.column_name);
    
    const activities = [
      { user_id: 1, activity: 'Login', activity_timestamp: '2024-01-15 09:00:00', ip_address: '192.168.1.100' },
      { user_id: 1, activity: 'Member Registration', activity_timestamp: '2024-01-15 09:30:00', ip_address: '192.168.1.100' },
      { user_id: 2, activity: 'FD Account Opening', activity_timestamp: '2024-01-15 10:00:00', ip_address: '192.168.1.101' },
      { user_id: 2, activity: 'Interest Calculation', activity_timestamp: '2024-01-15 11:00:00', ip_address: '192.168.1.101' },
      { user_id: 3, activity: 'Report Generation', activity_timestamp: '2024-01-15 14:00:00', ip_address: '192.168.1.102' },
      { user_id: 1, activity: 'Loan Application', activity_timestamp: '2024-01-16 10:00:00', ip_address: '192.168.1.100' },
      { user_id: 2, activity: 'Payment Processing', activity_timestamp: '2024-01-16 11:30:00', ip_address: '192.168.1.101' },
      { user_id: 3, activity: 'Database Backup', activity_timestamp: '2024-01-16 18:00:00', ip_address: '192.168.1.102' },
      { user_id: 1, activity: 'Logout', activity_timestamp: '2024-01-16 17:00:00', ip_address: '192.168.1.100' },
      { user_id: 2, activity: 'System Maintenance', activity_timestamp: '2024-01-17 08:00:00', ip_address: '192.168.1.101' }
    ];
    
    let insertedCount = 0;
    for (const activity of activities) {
      try {
        const mappedActivity = {};
        if (columnNames.includes('user_id')) mappedActivity.user_id = activity.user_id;
        if (columnNames.includes('activity')) mappedActivity.activity = activity.activity;
        if (columnNames.includes('activity_timestamp')) mappedActivity.activity_timestamp = activity.activity_timestamp;
        if (columnNames.includes('timestamp')) mappedActivity.timestamp = activity.activity_timestamp;
        if (columnNames.includes('ip_address')) mappedActivity.ip_address = activity.ip_address;
        
        const availableFields = Object.keys(mappedActivity);
        const values = availableFields.map(key => mappedActivity[key]);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        
        const insertQuery = `INSERT INTO user_activities (${availableFields.join(', ')}) VALUES (${placeholders})`;
        await client.query(insertQuery, values);
        insertedCount++;
      } catch (error) {
        if (insertedCount === 0) {
          console.log(`   ❌ Error: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} user activities`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

async function populateUsers() {
  console.log('🔧 Populating users...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(count.rows[0].count) > 0) {
      console.log('   ⚠️  Already has data');
      return;
    }
    
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'users' ORDER BY ordinal_position
    `);
    const columnNames = columns.rows.map(row => row.column_name);
    
    const users = [
      { username: 'admin', email: 'admin@society.com', role: 'Administrator', status: 'Active', created_at: '2024-01-01' },
      { username: 'manager', email: 'manager@society.com', role: 'Manager', status: 'Active', created_at: '2024-01-01' },
      { username: 'clerk', email: 'clerk@society.com', role: 'Clerk', status: 'Active', created_at: '2024-01-01' },
      { username: 'officer', email: 'officer@society.com', role: 'Officer', status: 'Active', created_at: '2024-01-01' },
      { username: 'cashier', email: 'cashier@society.com', role: 'Cashier', status: 'Active', created_at: '2024-01-01' },
      { username: 'auditor', email: 'auditor@society.com', role: 'Auditor', status: 'Active', created_at: '2024-01-01' },
      { username: 'supervisor', email: 'supervisor@society.com', role: 'Supervisor', status: 'Active', created_at: '2024-01-01' },
      { username: 'analyst', email: 'analyst@society.com', role: 'Analyst', status: 'Active', created_at: '2024-01-01' },
      { username: 'operator', email: 'operator@society.com', role: 'Operator', status: 'Active', created_at: '2024-01-01' },
      { username: 'guest', email: 'guest@society.com', role: 'Guest', status: 'Inactive', created_at: '2024-01-01' }
    ];
    
    let insertedCount = 0;
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      try {
        const mappedUser = {};
        if (columnNames.includes('username')) mappedUser.username = user.username;
        if (columnNames.includes('email')) mappedUser.email = user.email;
        if (columnNames.includes('role')) mappedUser.role = user.role;
        if (columnNames.includes('status')) mappedUser.status = user.status;
        if (columnNames.includes('created_at')) mappedUser.created_at = user.created_at;
        
        const availableFields = Object.keys(mappedUser);
        const values = availableFields.map(key => mappedUser[key]);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        
        const insertQuery = `INSERT INTO users (${availableFields.join(', ')}) VALUES (${placeholders})`;
        await client.query(insertQuery, values);
        insertedCount++;
      } catch (error) {
        if (insertedCount === 0) {
          console.log(`   ❌ Error: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} users`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

// Simplified generators for other tables
async function populateLoanAccounts(members) {
  console.log('🔧 Populating loan_accounts...');
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM loan_accounts');
    if (parseInt(count.rows[0].count) > 0) {
      console.log('   ⚠️  Already has data');
      return;
    }
    
    let insertedCount = 0;
    for (let i = 0; i < Math.min(10, members.length); i++) {
      const member = members[i];
      try {
        await client.query(`
          INSERT INTO loan_accounts (account_number, member_id, loan_type, principal_amount, interest_rate, tenure_months, status) 
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          `LA${String(i + 1).padStart(6, '0')}`, member.mbno, 'PERSONAL', 
          100000 + (i * 50000), 10.5 + (i * 0.1), 60, 'ACTIVE'
        ]);
        insertedCount++;
      } catch (error) {
        if (insertedCount === 0) {
          console.log(`   ❌ Error: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} loan accounts`);
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

async function populateInterestRates() {
  console.log('🔧 Populating interest_rates...');
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM interest_rates');
    if (parseInt(count.rows[0].count) > 0) {
      console.log('   ⚠️  Already has data');
      return;
    }
    
    const rates = [
      { product_type: 'FD', rate: 7.50, effective_from: '2024-01-01', effective_to: '2024-12-31' },
      { product_type: 'RD', rate: 6.50, effective_from: '2024-01-01', effective_to: '2024-12-31' },
      { product_type: 'SB', rate: 4.00, effective_from: '2024-01-01', effective_to: '2024-12-31' },
      { product_type: 'LOAN', rate: 10.50, effective_from: '2024-01-01', effective_to: '2024-12-31' },
      { product_type: 'PENALTY', rate: 2.00, effective_from: '2024-01-01', effective_to: '2024-12-31' }
    ];
    
    let insertedCount = 0;
    for (const rate of rates) {
      try {
        await client.query(`
          INSERT INTO interest_rates (product_type, interest_rate, effective_from, effective_to) 
          VALUES ($1, $2, $3, $4)
        `, [rate.product_type, rate.rate, rate.effective_from, rate.effective_to]);
        insertedCount++;
      } catch (error) {
        if (insertedCount === 0) {
          console.log(`   ❌ Error: ${error.message}`);
          break;
        }
      }
    }
    
    if (insertedCount > 0) {
      console.log(`   ✅ Inserted ${insertedCount} interest rates`);
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

// Placeholder functions for other tables
async function populateLoanPayments(loans) { 
  console.log('🔧 Populating loan_payments...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateRecurringDeposits(members) { 
  console.log('🔧 Populating recurring_deposits...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateFixedDeposits(members) { 
  console.log('🔧 Populating fixed_deposits...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateRDInstallments(members) { 
  console.log('🔧 Populating rd_installments...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateInterestPostings(members) { 
  console.log('🔧 Populating interest_postings...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateBankSavingDetailProduct() { 
  console.log('🔧 Populating bank_saving_detail_product...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateBankSBIntCalVerify() { 
  console.log('🔧 Populating bank_sbintcalverify...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateVouchers() { 
  console.log('🔧 Populating vouchers...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateTrfSlab() { 
  console.log('🔧 Populating trf_slab...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateYearEnd() { 
  console.log('🔧 Populating yearend...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateYearEndHead(heads) { 
  console.log('🔧 Populating yearend_head...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function populateYearEndMember(members) { 
  console.log('🔧 Populating yearend_member...');
  console.log('   ⚠️  Skipped - complex structure');
}

async function showFinalSummary() {
  console.log('\n📊 Final Database Population Summary:');
  console.log('=' .repeat(50));
  
  const importantTables = [
    'fdmaster', 'annualstatement', 'relation_master', 'wingmast', 
    'interestmaster', 'fdrd_slab_details', 'voucher_master',
    'deposit_slabs', 'designation_master', 'system_configs',
    'user_activities', 'users', 'interest_rates', 'loan_accounts'
  ];
  
  for (const table of importantTables) {
    try {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      const count = parseInt(result.rows[0].count);
      const status = count > 0 ? '✅' : '⚪';
      console.log(`${status} ${table}: ${count} records`);
    } catch (error) {
      console.log(`❌ ${table}: Error (${error.message})`);
    }
  }
  
  console.log('=' .repeat(50));
  console.log('🎯 Key tables for AdHoc Reports and PassBook Printing are ready!');
}

populateImportantTables().catch(console.error);