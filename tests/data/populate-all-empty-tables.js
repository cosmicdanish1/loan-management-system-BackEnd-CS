const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function populateAllEmptyTables() {
  try {
    await client.connect();
    console.log('🎯 COMPREHENSIVE DATABASE POPULATION - ALL EMPTY TABLES\n');
    console.log('=' .repeat(70));

    // Get all empty tables
    const emptyTables = await getEmptyTables();
    console.log(`📊 Found ${emptyTables.length} empty tables to populate\n`);

    let successCount = 0;
    let errorCount = 0;

    // Populate each empty table
    for (const tableName of emptyTables) {
      try {
        console.log(`🔧 Populating: ${tableName}`);
        const result = await populateTable(tableName);
        if (result.success) {
          console.log(`   ✅ Success: ${result.recordsInserted} records inserted`);
          successCount++;
        } else {
          console.log(`   ⚠️  Skipped: ${result.reason}`);
        }
      } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
        errorCount++;
      }
    }

    console.log('\n' + '=' .repeat(70));
    console.log('📊 FINAL POPULATION SUMMARY');
    console.log('=' .repeat(70));
    
    // Show final status of all tables
    await showCompleteDatabaseStatus();
    
    console.log(`\n🎯 Population Results:`);
    console.log(`   ✅ Successfully populated: ${successCount} tables`);
    console.log(`   ❌ Failed to populate: ${errorCount} tables`);
    console.log(`   📊 Total tables processed: ${emptyTables.length}`);
    
  } catch (error) {
    console.error('❌ Population error:', error);
  } finally {
    await client.end();
  }
}

async function getEmptyTables() {
  const query = `
    SELECT 
      table_name
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  
  const result = await client.query(query);
  const emptyTables = [];
  
  for (const row of result.rows) {
    try {
      const countResult = await client.query(`SELECT COUNT(*) as count FROM "${row.table_name}"`);
      const count = parseInt(countResult.rows[0].count);
      
      if (count === 0) {
        emptyTables.push(row.table_name);
      }
    } catch (error) {
      // Skip tables that can't be queried
      console.log(`   ⚠️  Skipping ${row.table_name}: ${error.message}`);
    }
  }
  
  return emptyTables;
}

async function populateTable(tableName) {
  try {
    // Get table structure
    const columns = await getTableColumns(tableName);
    if (columns.length === 0) {
      return { success: false, reason: 'No columns found' };
    }

    // Generate sample data based on table name and columns
    const sampleData = generateSampleData(tableName, columns);
    if (sampleData.length === 0) {
      return { success: false, reason: 'No sample data generated' };
    }

    // Insert data
    let insertedCount = 0;
    for (const record of sampleData) {
      try {
        const insertResult = await insertRecord(tableName, columns, record);
        if (insertResult) insertedCount++;
      } catch (error) {
        // Continue with other records if one fails
        if (insertedCount === 0) {
          throw error; // If first record fails, throw error
        }
      }
    }

    return { success: true, recordsInserted: insertedCount };
    
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

async function getTableColumns(tableName) {
  const query = `
    SELECT 
      column_name,
      data_type,
      is_nullable,
      column_default,
      character_maximum_length,
      numeric_precision,
      numeric_scale
    FROM information_schema.columns 
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `;
  
  const result = await client.query(query, [tableName]);
  return result.rows;
}

function generateSampleData(tableName, columns) {
  const recordCount = 10; // Generate 10 records for each table
  const records = [];

  for (let i = 0; i < recordCount; i++) {
    const record = {};
    
    for (const column of columns) {
      // Skip auto-increment columns
      if (column.column_default && column.column_default.includes('nextval')) {
        continue;
      }

      const value = generateColumnValue(tableName, column, i);
      if (value !== null) {
        record[column.column_name] = value;
      }
    }
    
    records.push(record);
  }

  return records;
}

function generateColumnValue(tableName, column, index) {
  const { column_name, data_type, is_nullable } = column;
  const colName = column_name.toLowerCase();

  // Handle nullable columns - sometimes return null
  if (is_nullable === 'YES' && Math.random() < 0.2) {
    return null;
  }

  // Generate based on column name patterns
  if (colName.includes('id') && !colName.includes('mbno') && !colName.includes('member')) {
    return index + 1;
  }
  
  if (colName.includes('name') || colName.includes('title') || colName.includes('description')) {
    return generateNameValue(tableName, colName, index);
  }
  
  if (colName.includes('code') || colName.includes('no')) {
    return generateCodeValue(tableName, colName, index);
  }
  
  if (colName.includes('date') || colName.includes('time')) {
    return generateDateValue(colName, index);
  }
  
  if (colName.includes('amount') || colName.includes('balance') || colName.includes('rate') || colName.includes('salary')) {
    return generateAmountValue(colName, index);
  }
  
  if (colName.includes('status') || colName.includes('flag') || colName.includes('active')) {
    return generateStatusValue(colName);
  }
  
  if (colName.includes('address')) {
    return `${index + 1} Sample Street, City ${index + 1}, State, PIN-${400000 + index}`;
  }
  
  if (colName.includes('phone') || colName.includes('mobile')) {
    return `98765${String(index).padStart(5, '0')}`;
  }
  
  if (colName.includes('email')) {
    return `user${index + 1}@society.com`;
  }

  // Generate based on data type
  switch (data_type) {
    case 'integer':
    case 'bigint':
    case 'smallint':
      return Math.floor(Math.random() * 1000) + index;
      
    case 'numeric':
    case 'decimal':
    case 'real':
    case 'double precision':
      return parseFloat((Math.random() * 10000 + index).toFixed(2));
      
    case 'character varying':
    case 'varchar':
    case 'text':
    case 'character':
    case 'char':
      return generateTextValue(tableName, colName, index);
      
    case 'boolean':
      return Math.random() < 0.7; // 70% true
      
    case 'date':
      return new Date(2024, Math.floor(Math.random() * 12), Math.floor(Math.random() * 28) + 1).toISOString().split('T')[0];
      
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return new Date(2024, Math.floor(Math.random() * 12), Math.floor(Math.random() * 28) + 1).toISOString();
      
    default:
      return `Sample_${index + 1}`;
  }
}

function generateNameValue(tableName, colName, index) {
  const names = [
    'Administration', 'Finance', 'Operations', 'HR', 'Marketing', 'Sales', 'IT', 'Accounts', 'Legal', 'Audit'
  ];
  
  if (colName.includes('first') || colName.includes('f_name')) {
    const firstNames = ['Rajesh', 'Priya', 'Amit', 'Sunita', 'Vikash', 'Meera', 'Suresh', 'Kavita', 'Ravi', 'Anita'];
    return firstNames[index % firstNames.length];
  }
  
  if (colName.includes('last') || colName.includes('l_name')) {
    const lastNames = ['Kumar', 'Sharma', 'Singh', 'Patel', 'Gupta', 'Agarwal', 'Jain', 'Shah', 'Verma', 'Yadav'];
    return lastNames[index % lastNames.length];
  }
  
  if (colName.includes('middle') || colName.includes('m_name')) {
    const middleNames = ['Kumar', 'Devi', 'Lal', 'Bai', 'Chand', 'Singh', 'Rani', 'Das', 'Nath', 'Prasad'];
    return middleNames[index % middleNames.length];
  }
  
  return `${names[index % names.length]}_${index + 1}`;
}

function generateCodeValue(tableName, colName, index) {
  if (colName.includes('member') || colName.includes('mbno')) {
    return 610000000 + index;
  }
  
  if (colName.includes('account')) {
    return 500000 + index;
  }
  
  if (colName.includes('loan')) {
    return `LN${String(index + 1).padStart(6, '0')}`;
  }
  
  if (colName.includes('voucher')) {
    return `V${String(index + 1).padStart(4, '0')}`;
  }
  
  return `${tableName.substring(0, 3).toUpperCase()}${String(index + 1).padStart(3, '0')}`;
}

function generateDateValue(colName, index) {
  const baseDate = new Date(2024, 0, 1);
  const randomDays = Math.floor(Math.random() * 365);
  const date = new Date(baseDate.getTime() + randomDays * 24 * 60 * 60 * 1000);
  
  if (colName.includes('time') || colName.includes('timestamp')) {
    return date.toISOString();
  }
  
  return date.toISOString().split('T')[0];
}

function generateAmountValue(colName, index) {
  if (colName.includes('rate') || colName.includes('interest')) {
    return parseFloat((5 + Math.random() * 10).toFixed(2)); // 5-15%
  }
  
  if (colName.includes('salary') || colName.includes('pay')) {
    return parseFloat((25000 + Math.random() * 75000).toFixed(2)); // 25k-100k
  }
  
  if (colName.includes('balance') || colName.includes('amount')) {
    return parseFloat((1000 + Math.random() * 99000).toFixed(2)); // 1k-100k
  }
  
  return parseFloat((Math.random() * 10000).toFixed(2));
}

function generateStatusValue(colName) {
  if (colName.includes('active') || colName.includes('isactive')) {
    return Math.random() < 0.8 ? 'Y' : 'N';
  }
  
  if (colName.includes('flag')) {
    return Math.random() < 0.7 ? 'Y' : 'N';
  }
  
  if (colName.includes('status')) {
    const statuses = ['ACTIVE', 'INACTIVE', 'PENDING', 'APPROVED', 'REJECTED'];
    return statuses[Math.floor(Math.random() * statuses.length)];
  }
  
  return 'ACTIVE';
}

function generateTextValue(tableName, colName, index) {
  if (colName.includes('description') || colName.includes('narration')) {
    return `Sample description for ${tableName} record ${index + 1}`;
  }
  
  if (colName.includes('remarks') || colName.includes('comment')) {
    return `Sample remarks for record ${index + 1}`;
  }
  
  if (colName.includes('type')) {
    const types = ['TYPE_A', 'TYPE_B', 'TYPE_C', 'REGULAR', 'SPECIAL'];
    return types[index % types.length];
  }
  
  return `Sample_${tableName}_${index + 1}`;
}

async function insertRecord(tableName, columns, record) {
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  
  const values = keys.map(key => record[key]);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
  const columnNames = keys.join(', ');
  
  const insertQuery = `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders})`;
  
  try {
    await client.query(insertQuery, values);
    return true;
  } catch (error) {
    throw new Error(`Insert failed: ${error.message}`);
  }
}

async function showCompleteDatabaseStatus() {
  console.log('📊 COMPLETE DATABASE STATUS:');
  console.log('-' .repeat(70));
  
  const query = `
    SELECT 
      table_name
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  
  const result = await client.query(query);
  let totalTables = 0;
  let populatedTables = 0;
  let emptyTables = 0;
  
  for (const row of result.rows) {
    try {
      const countResult = await client.query(`SELECT COUNT(*) as count FROM "${row.table_name}"`);
      const count = parseInt(countResult.rows[0].count);
      totalTables++;
      
      if (count > 0) {
        console.log(`✅ ${row.table_name}: ${count} records`);
        populatedTables++;
      } else {
        console.log(`⚪ ${row.table_name}: 0 records`);
        emptyTables++;
      }
    } catch (error) {
      console.log(`❌ ${row.table_name}: Error (${error.message})`);
      totalTables++;
    }
  }
  
  console.log('-' .repeat(70));
  console.log(`📊 SUMMARY: ${totalTables} total tables`);
  console.log(`   ✅ Populated: ${populatedTables} tables`);
  console.log(`   ⚪ Empty: ${emptyTables} tables`);
  console.log(`   📈 Population Rate: ${((populatedTables / totalTables) * 100).toFixed(1)}%`);
}

populateAllEmptyTables().catch(console.error);