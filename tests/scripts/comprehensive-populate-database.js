const { Client } = require('pg');
const fs = require('fs');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function comprehensivePopulateDatabase() {
  try {
    await client.connect();
    console.log('🔍 Comprehensive Database Population Based on EMS.sql Structure...\n');

    // Get existing member numbers for reference
    const membersResult = await client.query('SELECT mbno, f_name, m_name, l_name FROM member_master LIMIT 10');
    const members = membersResult.rows;
    
    if (members.length === 0) {
      console.log('❌ No members found in member_master table');
      return;
    }
    
    console.log(`Found ${members.length} existing members for reference`);

    // 1. Populate relation_master
    await populateRelationMaster();
    
    // 2. Populate wingmast (Wing Master)
    await populateWingMaster();
    
    // 3. Populate division_master
    await populateDivisionMaster();
    
    // 4. Populate membertypemaster
    await populateMemberTypeMaster();
    
    // 5. Populate castcategorymaster
    await populateCastCategoryMaster();
    
    // 6. Populate operationmodemaster
    await populateOperationModeMaster();
    
    // 7. Populate parameter_setting
    await populateParameterSetting();
    
    // 8. Populate interestmaster
    await populateInterestMaster();
    
    // 9. Populate fdrd_slab_details
    await populateFDRDSlabDetails();
    
    // 10. Populate voucher_master
    await populateVoucherMaster();
    
    // 11. Populate access_recovery
    await populateAccessRecovery(members);
    
    // 12. Populate guarrenter_mast
    await populateGuarrenterMast(members);
    
    // 13. Populate fd_interest_master
    await populateFDInterestMaster(members);
    
    // 14. Populate bank_saving_product
    await populateBankSavingProduct();
    
    // 15. Populate system_configs
    await populateSystemConfigs();
    
    // 16. Populate user_activities
    await populateUserActivities();
    
    console.log('\n✅ Comprehensive database population completed!');
    
    // Verify population
    await verifyPopulation();
    
  } catch (error) {
    console.error('Population error:', error);
  } finally {
    await client.end();
  }
}

async function populateRelationMaster() {
  console.log('🔧 Populating relation_master...');
  
  const relations = [
    { id: 1, name: 'Father' },
    { id: 2, name: 'Mother' },
    { id: 3, name: 'Spouse' },
    { id: 4, name: 'Son' },
    { id: 5, name: 'Daughter' },
    { id: 6, name: 'Brother' },
    { id: 7, name: 'Sister' },
    { id: 8, name: 'Uncle' },
    { id: 9, name: 'Aunt' },
    { id: 10, name: 'Grandfather' }
  ];
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM relation_master');
    if (parseInt(count.rows[0].count) === 0) {
      for (const relation of relations) {
        await client.query(
          'INSERT INTO relation_master (relation_id, relation_name) VALUES ($1, $2)',
          [relation.id, relation.name]
        );
      }
      console.log(`✅ Inserted ${relations.length} relations`);
    } else {
      console.log(`⚠️  Relation master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating relation_master: ${error.message}`);
  }
}

async function populateWingMaster() {
  console.log('🔧 Populating wingmast...');
  
  const wings = [
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
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM wingmast');
    if (parseInt(count.rows[0].count) === 0) {
      for (const wing of wings) {
        await client.query(
          'INSERT INTO wingmast (wingno, wname, winstate) VALUES ($1, $2, $3)',
          [wing.wingno, wing.wname, wing.winstate]
        );
      }
      console.log(`✅ Inserted ${wings.length} wings`);
    } else {
      console.log(`⚠️  Wing master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating wingmast: ${error.message}`);
  }
}

async function populateDivisionMaster() {
  console.log('🔧 Populating division_master...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM division_master');
    if (parseInt(count.rows[0].count) === 0) {
      // Get wing numbers
      const wings = await client.query('SELECT wingno FROM wingmast LIMIT 5');
      
      for (let i = 0; i < wings.rows.length; i++) {
        const wing = wings.rows[i];
        await client.query(`
          INSERT INTO division_master (wingno, divno, name, address, city) 
          VALUES ($1, $2, $3, $4, $5)
        `, [
          wing.wingno, 
          i + 1, 
          `Division ${i + 1} - ${wing.wingno}`,
          `${i + 1}/123, Sector ${i + 10}, Business District`,
          'NAGPUR'
        ]);
      }
      console.log(`✅ Inserted ${wings.rows.length} divisions`);
    } else {
      console.log(`⚠️  Division master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating division_master: ${error.message}`);
  }
}

async function populateMemberTypeMaster() {
  console.log('🔧 Populating membertypemaster...');
  
  const memberTypes = [
    'Regular Member',
    'Associate Member',
    'Honorary Member',
    'Life Member',
    'Temporary Member',
    'Corporate Member',
    'Student Member',
    'Senior Citizen Member',
    'Ex-Employee Member',
    'Special Category Member'
  ];
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM membertypemaster');
    if (parseInt(count.rows[0].count) === 0) {
      for (const memberType of memberTypes) {
        await client.query(
          'INSERT INTO membertypemaster (membertype) VALUES ($1)',
          [memberType]
        );
      }
      console.log(`✅ Inserted ${memberTypes.length} member types`);
    } else {
      console.log(`⚠️  Member type master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating membertypemaster: ${error.message}`);
  }
}

async function populateCastCategoryMaster() {
  console.log('🔧 Populating castcategorymaster...');
  
  const castCategories = [
    'General',
    'OBC (Other Backward Class)',
    'SC (Scheduled Caste)',
    'ST (Scheduled Tribe)',
    'EWS (Economically Weaker Section)',
    'Minority',
    'PH (Physically Handicapped)',
    'Ex-Serviceman',
    'Freedom Fighter',
    'Sports Quota'
  ];
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM castcategorymaster');
    if (parseInt(count.rows[0].count) > 0) {
      console.log(`⚠️  Cast category master already has ${count.rows[0].count} records`);
      return;
    }
    
    for (const category of castCategories) {
      await client.query(
        'INSERT INTO castcategorymaster (castcategory) VALUES ($1)',
        [category]
      );
    }
    console.log(`✅ Inserted ${castCategories.length} cast categories`);
  } catch (error) {
    console.log(`❌ Error populating castcategorymaster: ${error.message}`);
  }
}

async function populateOperationModeMaster() {
  console.log('🔧 Populating operationmodemaster...');
  
  const operationModes = [
    'Normal Operation',
    'Emergency Mode',
    'Maintenance Mode',
    'Audit Mode',
    'Year End Processing',
    'Backup Mode',
    'Recovery Mode',
    'Migration Mode',
    'Testing Mode',
    'Training Mode'
  ];
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM operationmodemaster');
    if (parseInt(count.rows[0].count) === 0) {
      for (const mode of operationModes) {
        await client.query(
          'INSERT INTO operationmodemaster (description) VALUES ($1)',
          [mode]
        );
      }
      console.log(`✅ Inserted ${operationModes.length} operation modes`);
    } else {
      console.log(`⚠️  Operation mode master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating operationmodemaster: ${error.message}`);
  }
}

async function populateParameterSetting() {
  console.log('🔧 Populating parameter_setting...');
  
  const parameters = [
    { code: 'INTEREST_RATE_FD', value: '7.50', desc: 'Fixed Deposit Interest Rate' },
    { code: 'INTEREST_RATE_RD', value: '6.50', desc: 'Recurring Deposit Interest Rate' },
    { code: 'INTEREST_RATE_SB', value: '4.00', desc: 'Savings Account Interest Rate' },
    { code: 'MIN_FD_AMOUNT', value: '10000', desc: 'Minimum Fixed Deposit Amount' },
    { code: 'MIN_RD_AMOUNT', value: '500', desc: 'Minimum Recurring Deposit Amount' },
    { code: 'LOAN_INTEREST_RATE', value: '10.50', desc: 'Loan Interest Rate' },
    { code: 'PENALTY_RATE', value: '2.00', desc: 'Penalty Interest Rate' },
    { code: 'SHARE_FACE_VALUE', value: '100', desc: 'Share Face Value' },
    { code: 'MIN_SHARE_HOLDING', value: '10', desc: 'Minimum Share Holding' },
    { code: 'FINANCIAL_YEAR_START', value: '04-01', desc: 'Financial Year Start Date' }
  ];
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM parameter_setting');
    if (parseInt(count.rows[0].count) > 10) {
      console.log(`⚠️  Parameter setting already has ${count.rows[0].count} records`);
      return;
    }
    
    for (const param of parameters) {
      await client.query(
        'INSERT INTO parameter_setting (param_code, param_value, param_desc) VALUES ($1, $2, $3)',
        [param.code, param.value, param.desc]
      );
    }
    console.log(`✅ Inserted ${parameters.length} parameters`);
  } catch (error) {
    console.log(`❌ Error populating parameter_setting: ${error.message}`);
  }
}

async function populateInterestMaster() {
  console.log('🔧 Populating interestmaster...');
  
  const interestRates = [
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
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM interestmaster');
    if (parseInt(count.rows[0].count) === 0) {
      for (const rate of interestRates) {
        await client.query(
          'INSERT INTO interestmaster (inttype, frdt, todt, rate) VALUES ($1, $2, $3, $4)',
          [rate.inttype, rate.frdt, rate.todt, rate.rate]
        );
      }
      console.log(`✅ Inserted ${interestRates.length} interest rates`);
    } else {
      console.log(`⚠️  Interest master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating interestmaster: ${error.message}`);
  }
}

async function populateFDRDSlabDetails() {
  console.log('🔧 Populating fdrd_slab_details...');
  
  const slabs = [
    { fdrd: 'FD', scheme_code: 'FD01', from_amount: 10000, upto_amount: 50000, from_period: 12, upto_period: 24, period_unit: 'M', interest_rate: 7.50, premature_interest_rate: 6.50, applicable_from_date: '2024-01-01' },
    { fdrd: 'FD', scheme_code: 'FD02', from_amount: 50001, upto_amount: 100000, from_period: 12, upto_period: 36, period_unit: 'M', interest_rate: 7.75, premature_interest_rate: 6.75, applicable_from_date: '2024-01-01' },
    { fdrd: 'FD', scheme_code: 'FD03', from_amount: 100001, upto_amount: 500000, from_period: 24, upto_period: 60, period_unit: 'M', interest_rate: 8.00, premature_interest_rate: 7.00, applicable_from_date: '2024-01-01' },
    { fdrd: 'RD', scheme_code: 'RD01', from_amount: 500, upto_amount: 5000, from_period: 12, upto_period: 60, period_unit: 'M', interest_rate: 6.50, premature_interest_rate: 5.50, applicable_from_date: '2024-01-01' },
    { fdrd: 'RD', scheme_code: 'RD02', from_amount: 5001, upto_amount: 25000, from_period: 12, upto_period: 120, period_unit: 'M', interest_rate: 6.75, premature_interest_rate: 5.75, applicable_from_date: '2024-01-01' }
  ];
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM fdrd_slab_details');
    if (parseInt(count.rows[0].count) === 0) {
      for (const slab of slabs) {
        await client.query(`
          INSERT INTO fdrd_slab_details (
            fdrd, scheme_code, from_amount, upto_amount, from_period, upto_period, 
            period_unit, interest_rate, premature_interest_rate, applicable_from_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          slab.fdrd, slab.scheme_code, slab.from_amount, slab.upto_amount,
          slab.from_period, slab.upto_period, slab.period_unit, slab.interest_rate,
          slab.premature_interest_rate, slab.applicable_from_date
        ]);
      }
      console.log(`✅ Inserted ${slabs.length} FD/RD slabs`);
    } else {
      console.log(`⚠️  FDRD slab details already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating fdrd_slab_details: ${error.message}`);
  }
}

async function populateVoucherMaster() {
  console.log('🔧 Populating voucher_master...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM voucher_master');
    if (parseInt(count.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO voucher_master (p_vchr_no, r_vchr_no, j_vchr_no, d_vchr_no) 
        VALUES ($1, $2, $3, $4)
      `, ['P00001', 'R00001', 'J00001', 'D00001']);
      
      console.log('✅ Inserted voucher master record');
    } else {
      console.log(`⚠️  Voucher master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating voucher_master: ${error.message}`);
  }
}

async function populateAccessRecovery(members) {
  console.log('🔧 Populating access_recovery...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM access_recovery');
    if (parseInt(count.rows[0].count) === 0) {
      const accTypes = ['FD', 'RD', 'SB', 'LN'];
      
      for (let i = 0; i < Math.min(5, members.length); i++) {
        const member = members[i];
        const accType = accTypes[i % accTypes.length];
        
        await client.query(`
          INSERT INTO access_recovery (mbno, acc_type, short_amount, short_interest_amount) 
          VALUES ($1, $2, $3, $4)
        `, [member.mbno, accType, 1000 + (i * 500), 100 + (i * 50)]);
      }
      console.log(`✅ Inserted ${Math.min(5, members.length)} access recovery records`);
    } else {
      console.log(`⚠️  Access recovery already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating access_recovery: ${error.message}`);
  }
}

async function populateGuarrenterMast(members) {
  console.log('🔧 Populating guarrenter_mast...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM guarrenter_mast');
    if (parseInt(count.rows[0].count) === 0) {
      for (let i = 0; i < Math.min(5, members.length); i++) {
        const member = members[i];
        const balance = 50000 + (i * 25000);
        
        await client.query(`
          INSERT INTO guarrenter_mast (guarrenter_mbno, balance, openbalance) 
          VALUES ($1, $2, $3)
        `, [member.mbno.toString(), balance, balance]);
      }
      console.log(`✅ Inserted ${Math.min(5, members.length)} guarantor records`);
    } else {
      console.log(`⚠️  Guarrenter mast already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating guarrenter_mast: ${error.message}`);
  }
}

async function populateFDInterestMaster(members) {
  console.log('🔧 Populating fd_interest_master...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM fd_interest_master');
    if (parseInt(count.rows[0].count) === 0) {
      // Get existing FD accounts
      const fdAccounts = await client.query('SELECT mbno, account_number, fdamount FROM fdmaster LIMIT 5');
      
      for (let i = 0; i < fdAccounts.rows.length; i++) {
        const fd = fdAccounts.rows[i];
        const interestAmount = Math.round(fd.fdamount * 0.075 / 12); // Monthly interest
        
        await client.query(`
          INSERT INTO fd_interest_master (
            interest_mst_id, mbno, account_number, amount, rate, 
            calc_from_date, calc_to_date, fdamount
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          i + 1, fd.mbno, fd.account_number, interestAmount, 7.50,
          '2024-01-01', '2024-01-31', fd.fdamount
        ]);
      }
      console.log(`✅ Inserted ${fdAccounts.rows.length} FD interest records`);
    } else {
      console.log(`⚠️  FD interest master already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating fd_interest_master: ${error.message}`);
  }
}

async function populateBankSavingProduct() {
  console.log('🔧 Populating bank_saving_product...');
  
  try {
    const count = await client.query('SELECT COUNT(*) as count FROM bank_saving_product');
    if (parseInt(count.rows[0].count) === 0) {
      const accounts = [
        '12345678901234', '23456789012345', '34567890123456', 
        '45678901234567', '56789012345678'
      ];
      
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const product = 10000 + (i * 5000);
        
        await client.query(`
          INSERT INTO bank_saving_product (
            account_number, from_date, to_date, product, posted, 
            post_int, intramt, rateofintr
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          account, '2024-01-01', '2024-12-31', product, 'Y',
          'Y', Math.round(product * 0.04), 4.00
        ]);
      }
      console.log(`✅ Inserted ${accounts.length} bank saving products`);
    } else {
      console.log(`⚠️  Bank saving product already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating bank_saving_product: ${error.message}`);
  }
}

async function populateSystemConfigs() {
  console.log('🔧 Populating system_configs...');
  
  try {
    // Check if table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'system_configs'
      );
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('⚠️  system_configs table does not exist');
      return;
    }
    
    const count = await client.query('SELECT COUNT(*) as count FROM system_configs');
    if (parseInt(count.rows[0].count) === 0) {
      const configs = [
        { key: 'APP_NAME', value: 'Employee Cooperative Society', description: 'Application Name' },
        { key: 'APP_VERSION', value: '2.0.0', description: 'Application Version' },
        { key: 'DB_VERSION', value: '1.5.0', description: 'Database Version' },
        { key: 'BACKUP_RETENTION_DAYS', value: '30', description: 'Backup Retention Period' },
        { key: 'SESSION_TIMEOUT', value: '30', description: 'Session Timeout in Minutes' }
      ];
      
      for (const config of configs) {
        await client.query(
          'INSERT INTO system_configs (config_key, config_value, description) VALUES ($1, $2, $3)',
          [config.key, config.value, config.description]
        );
      }
      console.log(`✅ Inserted ${configs.length} system configs`);
    } else {
      console.log(`⚠️  System configs already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating system_configs: ${error.message}`);
  }
}

async function populateUserActivities() {
  console.log('🔧 Populating user_activities...');
  
  try {
    // Check if table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'user_activities'
      );
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('⚠️  user_activities table does not exist');
      return;
    }
    
    const count = await client.query('SELECT COUNT(*) as count FROM user_activities');
    if (parseInt(count.rows[0].count) === 0) {
      const activities = [
        { user_id: 1, activity: 'Login', timestamp: '2024-01-15 09:00:00', ip_address: '192.168.1.100' },
        { user_id: 1, activity: 'Member Registration', timestamp: '2024-01-15 09:30:00', ip_address: '192.168.1.100' },
        { user_id: 2, activity: 'FD Account Opening', timestamp: '2024-01-15 10:00:00', ip_address: '192.168.1.101' },
        { user_id: 2, activity: 'Interest Calculation', timestamp: '2024-01-15 11:00:00', ip_address: '192.168.1.101' },
        { user_id: 3, activity: 'Report Generation', timestamp: '2024-01-15 14:00:00', ip_address: '192.168.1.102' }
      ];
      
      for (const activity of activities) {
        await client.query(
          'INSERT INTO user_activities (user_id, activity, activity_timestamp, ip_address) VALUES ($1, $2, $3, $4)',
          [activity.user_id, activity.activity, activity.timestamp, activity.ip_address]
        );
      }
      console.log(`✅ Inserted ${activities.length} user activities`);
    } else {
      console.log(`⚠️  User activities already has ${count.rows[0].count} records`);
    }
  } catch (error) {
    console.log(`❌ Error populating user_activities: ${error.message}`);
  }
}

async function verifyPopulation() {
  console.log('\n🔍 Verifying population results...');
  
  const tables = [
    'relation_master', 'wingmast', 'division_master', 'membertypemaster',
    'castcategorymaster', 'operationmodemaster', 'parameter_setting',
    'interestmaster', 'fdrd_slab_details', 'voucher_master',
    'access_recovery', 'guarrenter_mast', 'fd_interest_master',
    'bank_saving_product'
  ];
  
  for (const table of tables) {
    try {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      console.log(`📊 ${table}: ${result.rows[0].count} records`);
    } catch (error) {
      console.log(`❌ ${table}: Error (${error.message})`);
    }
  }
}

comprehensivePopulateDatabase().catch(console.error);