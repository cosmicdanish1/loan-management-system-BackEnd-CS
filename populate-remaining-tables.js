const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function populateRemainingTables() {
  try {
    await client.connect();
    console.log('🎯 TARGETED POPULATION - REMAINING EMPTY TABLES\n');
    console.log('=' .repeat(70));

    // Get all empty tables
    const emptyTables = await getEmptyTables();
    console.log(`📊 Found ${emptyTables.length} empty tables to populate\n`);

    let successCount = 0;
    let errorCount = 0;

    // Populate each empty table with better error handling
    for (const tableName of emptyTables) {
      try {
        console.log(`🔧 Populating: ${tableName}`);
        const result = await populateTableSafely(tableName);
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
    console.log('📊 FINAL DATABASE STATUS');
    console.log('=' .repeat(70));
    
    // Show final status
    await showFinalStatus();
    
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
    SELECT table_name
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
    }
  }
  
  return emptyTables;
}

async function populateTableSafely(tableName) {
  try {
    // Get table structure with detailed information
    const columns = await getDetailedTableColumns(tableName);
    if (columns.length === 0) {
      return { success: false, reason: 'No columns found' };
    }

    // Check for special table patterns that need custom handling
    if (await needsCustomHandling(tableName, columns)) {
      return await handleSpecialTable(tableName, columns);
    }

    // Generate safe sample data
    const sampleData = generateSafeData(tableName, columns);
    if (sampleData.length === 0) {
      return { success: false, reason: 'No safe sample data generated' };
    }

    // Insert data with better error handling
    let insertedCount = 0;
    for (const record of sampleData) {
      try {
        const success = await insertRecordSafely(tableName, record);
        if (success) insertedCount++;
        
        // Stop if we get 5 successful inserts
        if (insertedCount >= 5) break;
      } catch (error) {
        // If first record fails, stop trying
        if (insertedCount === 0) {
          throw error;
        }
      }
    }

    return { success: true, recordsInserted: insertedCount };
    
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

async function getDetailedTableColumns(tableName) {
  const query = `
    SELECT 
      column_name,
      data_type,
      is_nullable,
      column_default,
      character_maximum_length,
      numeric_precision,
      numeric_scale,
      udt_name
    FROM information_schema.columns 
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `;
  
  const result = await client.query(query, [tableName]);
  return result.rows;
}

async function needsCustomHandling(tableName, columns) {
  // Tables with money type or complex constraints
  const moneyColumns = columns.filter(col => col.udt_name === 'money');
  const hasComplexConstraints = columns.some(col => 
    col.character_maximum_length && col.character_maximum_length < 10
  );
  
  return moneyColumns.length > 0 || hasComplexConstraints;
}

async function handleSpecialTable(tableName, columns) {
  // Handle tables with money columns or strict constraints
  try {
    const record = {};
    
    for (const column of columns) {
      // Skip auto-increment columns
      if (column.column_default && column.column_default.includes('nextval')) {
        continue;
      }

      const value = generateSpecialValue(tableName, column);
      if (value !== null) {
        record[column.column_name] = value;
      }
    }

    if (Object.keys(record).length === 0) {
      return { success: false, reason: 'No valid columns for special handling' };
    }

    const success = await insertRecordSafely(tableName, record);
    return { success: success, recordsInserted: success ? 1 : 0 };
    
  } catch (error) {
    return { success: false, reason: `Special handling failed: ${error.message}` };
  }
}

function generateSpecialValue(tableName, column) {
  const { column_name, data_type, udt_name, character_maximum_length } = column;
  const colName = column_name.toLowerCase();

  // Handle money type
  if (udt_name === 'money') {
    return '100.00'; // Simple money value
  }

  // Handle strict length constraints
  if (character_maximum_length && character_maximum_length <= 5) {
    if (colName.includes('code') || colName.includes('id')) {
      return 'C001';
    }
    if (colName.includes('flag') || colName.includes('status')) {
      return 'Y';
    }
    return 'TEST';
  }

  // Handle specific column patterns
  if (colName.includes('mbno') || colName.includes('member')) {
    return 610023712; // Use existing member number
  }

  if (colName.includes('amount') || colName.includes('balance')) {
    if (udt_name === 'money') {
      return '1000.00';
    }
    return 1000.00;
  }

  if (colName.includes('rate') || colName.includes('interest')) {
    return 7.50;
  }

  if (colName.includes('date')) {
    return '2024-01-15';
  }

  // Default safe values by data type
  switch (data_type) {
    case 'integer':
    case 'bigint':
    case 'smallint':
      return 1;
      
    case 'numeric':
    case 'decimal':
    case 'real':
    case 'double precision':
      return 100.00;
      
    case 'character varying':
    case 'varchar':
    case 'text':
    case 'character':
    case 'char':
      const maxLen = character_maximum_length || 50;
      const baseValue = 'Sample';
      return baseValue.substring(0, Math.min(maxLen, baseValue.length));
      
    case 'boolean':
      return true;
      
    case 'date':
      return '2024-01-15';
      
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return '2024-01-15T10:00:00';
      
    default:
      return 'TEST';
  }
}

function generateSafeData(tableName, columns) {
  const records = [];
  
  // Generate 5 safe records
  for (let i = 0; i < 5; i++) {
    const record = {};
    
    for (const column of columns) {
      // Skip auto-increment columns
      if (column.column_default && column.column_default.includes('nextval')) {
        continue;
      }

      // Skip nullable columns sometimes
      if (column.is_nullable === 'YES' && Math.random() < 0.3) {
        continue;
      }

      const value = generateSafeValue(tableName, column, i);
      if (value !== null) {
        record[column.column_name] = value;
      }
    }
    
    if (Object.keys(record).length > 0) {
      records.push(record);
    }
  }

  return records;
}

function generateSafeValue(tableName, column, index) {
  const { column_name, data_type, udt_name, character_maximum_length } = column;
  const colName = column_name.toLowerCase();

  // Handle money type specifically
  if (udt_name === 'money') {
    return `${(1000 + index * 100)}.00`;
  }

  // Handle strict length constraints
  if (character_maximum_length) {
    if (character_maximum_length <= 5) {
      if (colName.includes('code')) {
        return `C${String(index + 1).padStart(2, '0')}`;
      }
      if (colName.includes('flag') || colName.includes('status')) {
        return index % 2 === 0 ? 'Y' : 'N';
      }
      return `T${index + 1}`;
    }
    
    if (character_maximum_length <= 10) {
      return `Sample${index + 1}`;
    }
  }

  // Handle specific patterns
  if (colName.includes('mbno') || colName.includes('member_no')) {
    return 610023712 + index; // Use existing member numbers
  }

  if (colName.includes('account') && colName.includes('no')) {
    return 500001 + index;
  }

  // Safe defaults by data type
  switch (data_type) {
    case 'integer':
    case 'bigint':
    case 'smallint':
      return index + 1;
      
    case 'numeric':
    case 'decimal':
    case 'real':
    case 'double precision':
      return parseFloat((100 + index * 10).toFixed(2));
      
    case 'character varying':
    case 'varchar':
    case 'text':
    case 'character':
    case 'char':
      const maxLen = character_maximum_length || 255;
      const value = `Sample_${index + 1}`;
      return value.substring(0, Math.min(maxLen, value.length));
      
    case 'boolean':
      return index % 2 === 0;
      
    case 'date':
      const date = new Date(2024, 0, 15 + index);
      return date.toISOString().split('T')[0];
      
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      const timestamp = new Date(2024, 0, 15 + index, 10, 0, 0);
      return timestamp.toISOString();
      
    default:
      return `Test${index + 1}`;
  }
}

async function insertRecordSafely(tableName, record) {
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  
  const values = keys.map(key => record[key]);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
  const columnNames = keys.map(key => `"${key}"`).join(', ');
  
  const insertQuery = `INSERT INTO "${tableName}" (${columnNames}) VALUES (${placeholders})`;
  
  try {
    await client.query(insertQuery, values);
    return true;
  } catch (error) {
    throw new Error(`Insert failed: ${error.message}`);
  }
}

async function showFinalStatus() {
  const query = `
    SELECT table_name
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
        populatedTables++;
      } else {
        emptyTables++;
      }
    } catch (error) {
      totalTables++;
    }
  }
  
  console.log(`📊 FINAL SUMMARY: ${totalTables} total tables`);
  console.log(`   ✅ Populated: ${populatedTables} tables (${((populatedTables / totalTables) * 100).toFixed(1)}%)`);
  console.log(`   ⚪ Empty: ${emptyTables} tables (${((emptyTables / totalTables) * 100).toFixed(1)}%)`);
  
  if (emptyTables > 0) {
    console.log(`\n📋 Remaining empty tables:`);
    for (const row of result.rows) {
      try {
        const countResult = await client.query(`SELECT COUNT(*) as count FROM "${row.table_name}"`);
        const count = parseInt(countResult.rows[0].count);
        if (count === 0) {
          console.log(`   ⚪ ${row.table_name}`);
        }
      } catch (error) {
        // Skip
      }
    }
  }
}

populateRemainingTables().catch(console.error);