const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function smartPopulateAllTables() {
  try {
    await client.connect();
    console.log('🎯 SMART DATABASE POPULATION - SCHEMA-AWARE APPROACH\n');
    console.log('=' .repeat(70));

    // Get all empty tables
    const emptyTables = await getEmptyTables();
    console.log(`📊 Found ${emptyTables.length} empty tables to populate\n`);

    let successCount = 0;
    let errorCount = 0;

    // Process each empty table with schema analysis
    for (const tableName of emptyTables) {
      try {
        console.log(`🔍 Analyzing: ${tableName}`);
        
        // Get complete table schema
        const schema = await getCompleteTableSchema(tableName);
        
        if (!schema.columns || schema.columns.length === 0) {
          console.log(`   ⚠️  Skipped: No accessible columns`);
          continue;
        }

        console.log(`   📋 Found ${schema.columns.length} columns, ${schema.constraints.length} constraints`);
        
        // Generate schema-aware sample data
        const sampleData = generateSchemaAwareSampleData(tableName, schema);
        
        if (sampleData.length === 0) {
          console.log(`   ⚠️  Skipped: No sample data could be generated`);
          continue;
        }

        // Insert data with proper error handling
        const result = await insertSchemaAwareData(tableName, schema, sampleData);
        
        if (result.success) {
          console.log(`   ✅ Success: ${result.recordsInserted} records inserted`);
          successCount++;
        } else {
          console.log(`   ⚠️  Partial: ${result.recordsInserted} records inserted, ${result.errors} errors`);
          if (result.recordsInserted > 0) successCount++;
        }
        
      } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
        errorCount++;
      }
      console.log('');
    }

    console.log('=' .repeat(70));
    console.log('📊 FINAL SMART POPULATION SUMMARY');
    console.log('=' .repeat(70));
    
    // Show final status
    await showFinalDatabaseStatus();
    
    console.log(`\n🎯 Smart Population Results:`);
    console.log(`   ✅ Successfully populated: ${successCount} tables`);
    console.log(`   ❌ Failed to populate: ${errorCount} tables`);
    console.log(`   📊 Total tables processed: ${emptyTables.length}`);
    
  } catch (error) {
    console.error('❌ Smart population error:', error);
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

async function getCompleteTableSchema(tableName) {
  // Get column information
  const columnsQuery = `
    SELECT 
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.column_default,
      c.character_maximum_length,
      c.numeric_precision,
      c.numeric_scale,
      c.udt_name,
      c.ordinal_position
    FROM information_schema.columns c
    WHERE c.table_name = $1 
      AND c.table_schema = 'public'
    ORDER BY c.ordinal_position
  `;

  // Get constraints information
  const constraintsQuery = `
    SELECT 
      tc.constraint_name,
      tc.constraint_type,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
    LEFT JOIN information_schema.constraint_column_usage ccu 
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.table_name = $1 
      AND tc.table_schema = 'public'
  `;

  // Get indexes information
  const indexesQuery = `
    SELECT 
      i.relname as index_name,
      a.attname as column_name,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary
    FROM pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE t.relname = $1
      AND t.relkind = 'r'
  `;

  try {
    const [columnsResult, constraintsResult, indexesResult] = await Promise.all([
      client.query(columnsQuery, [tableName]),
      client.query(constraintsQuery, [tableName]),
      client.query(indexesQuery, [tableName])
    ]);

    return {
      tableName,
      columns: columnsResult.rows,
      constraints: constraintsResult.rows,
      indexes: indexesResult.rows
    };
  } catch (error) {
    console.log(`   ⚠️  Schema analysis failed: ${error.message}`);
    return { tableName, columns: [], constraints: [], indexes: [] };
  }
}

function generateSchemaAwareSampleData(tableName, schema) {
  const recordCount = 10;
  const records = [];

  // Analyze schema for special patterns
  const primaryKeys = schema.constraints
    .filter(c => c.constraint_type === 'PRIMARY KEY')
    .map(c => c.column_name);
  
  const foreignKeys = schema.constraints
    .filter(c => c.constraint_type === 'FOREIGN KEY')
    .reduce((acc, c) => {
      acc[c.column_name] = { table: c.foreign_table_name, column: c.foreign_column_name };
      return acc;
    }, {});

  const uniqueColumns = schema.constraints
    .filter(c => c.constraint_type === 'UNIQUE')
    .map(c => c.column_name);

  for (let i = 0; i < recordCount; i++) {
    const record = {};
    
    for (const column of schema.columns) {
      // Skip auto-increment columns
      if (column.column_default && column.column_default.includes('nextval')) {
        continue;
      }

      const value = generateSchemaAwareValue(
        tableName, 
        column, 
        i, 
        {
          isPrimaryKey: primaryKeys.includes(column.column_name),
          isUnique: uniqueColumns.includes(column.column_name),
          foreignKey: foreignKeys[column.column_name]
        }
      );
      
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

function generateSchemaAwareValue(tableName, column, index, metadata) {
  const { column_name, data_type, is_nullable, character_maximum_length, udt_name } = column;
  const colName = column_name.toLowerCase();

  // Handle nullable columns
  if (is_nullable === 'YES' && Math.random() < 0.15) {
    return null;
  }

  // Handle foreign keys first
  if (metadata.foreignKey) {
    return generateForeignKeyValue(metadata.foreignKey, index);
  }

  // Handle primary keys and unique constraints
  if (metadata.isPrimaryKey || metadata.isUnique) {
    return generateUniqueValue(tableName, colName, data_type, index);
  }

  // Handle specific PostgreSQL data types
  switch (udt_name || data_type) {
    case 'money':
      return generateMoneyValue(colName, index);
    
    case 'uuid':
      return generateUUID();
    
    case 'json':
    case 'jsonb':
      return generateJSONValue(colName);
    
    case 'inet':
      return `192.168.1.${100 + index}`;
    
    case 'macaddr':
      return `00:1B:44:11:3A:${String(index).padStart(2, '0')}`;
  }

  // Handle by column name patterns
  if (colName.includes('email')) {
    return `user${index + 1}@${tableName}.com`;
  }
  
  if (colName.includes('phone') || colName.includes('mobile')) {
    return `+91-98765${String(index).padStart(5, '0')}`;
  }
  
  if (colName.includes('url') || colName.includes('website')) {
    return `https://www.${tableName}${index + 1}.com`;
  }

  if (colName.includes('password') || colName.includes('pwd')) {
    return '$2b$10$hashedpassword' + String(index).padStart(10, '0');
  }

  // Handle by data type with length constraints
  switch (data_type) {
    case 'character varying':
    case 'varchar':
    case 'text':
      return generateConstrainedText(tableName, colName, character_maximum_length, index);
    
    case 'character':
    case 'char':
      return generateFixedLengthText(colName, character_maximum_length, index);
    
    case 'integer':
    case 'bigint':
    case 'smallint':
      return generateIntegerValue(colName, index);
    
    case 'numeric':
    case 'decimal':
      return generateNumericValue(colName, column.numeric_precision, column.numeric_scale, index);
    
    case 'real':
    case 'double precision':
      return generateFloatValue(colName, index);
    
    case 'boolean':
      return generateBooleanValue(colName);
    
    case 'date':
      return generateDateValue(colName, index);
    
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return generateTimestampValue(colName, index);
    
    case 'time without time zone':
    case 'time with time zone':
      return generateTimeValue(index);
    
    default:
      return generateDefaultValue(tableName, colName, index);
  }
}

function generateForeignKeyValue(foreignKey, index) {
  // For now, generate reasonable foreign key values
  // In a more sophisticated version, we could query the referenced table
  if (foreignKey.table === 'member_master' && foreignKey.column === 'mbno') {
    return 610000000 + (index % 100); // Reference existing members
  }
  
  if (foreignKey.column.includes('id')) {
    return (index % 10) + 1; // Reference first 10 records
  }
  
  return index + 1;
}

function generateUniqueValue(tableName, colName, dataType, index) {
  if (dataType === 'integer' || dataType === 'bigint') {
    return index + 1;
  }
  
  return `${tableName}_${colName}_${index + 1}`;
}

function generateMoneyValue(colName, index) {
  if (colName.includes('salary') || colName.includes('pay')) {
    return (25000 + (index * 5000)).toFixed(2);
  }
  
  if (colName.includes('balance') || colName.includes('amount')) {
    return (1000 + (index * 1000)).toFixed(2);
  }
  
  return (100 + (index * 100)).toFixed(2);
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateJSONValue(colName) {
  return JSON.stringify({
    id: Math.floor(Math.random() * 1000),
    name: `Sample ${colName}`,
    created: new Date().toISOString()
  });
}

function generateConstrainedText(tableName, colName, maxLength, index) {
  let baseText = generateTextByColumnName(tableName, colName, index);
  
  if (maxLength && baseText.length > maxLength) {
    baseText = baseText.substring(0, maxLength);
  }
  
  return baseText;
}

function generateFixedLengthText(colName, length, index) {
  if (!length) return `CHAR${index}`;
  
  let text = generateTextByColumnName('', colName, index);
  
  if (text.length > length) {
    return text.substring(0, length);
  } else if (text.length < length) {
    return text.padEnd(length, '0');
  }
  
  return text;
}

function generateTextByColumnName(tableName, colName, index) {
  if (colName.includes('name')) {
    const names = ['Admin', 'Finance', 'Operations', 'HR', 'Marketing', 'Sales', 'IT', 'Legal', 'Audit', 'Support'];
    return names[index % names.length];
  }
  
  if (colName.includes('code')) {
    return `${colName.substring(0, 3).toUpperCase()}${String(index + 1).padStart(3, '0')}`;
  }
  
  if (colName.includes('description') || colName.includes('narration')) {
    return `Sample description for ${tableName} record ${index + 1}`;
  }
  
  if (colName.includes('address')) {
    return `${index + 1} Sample Street, City ${index + 1}`;
  }
  
  if (colName.includes('status')) {
    const statuses = ['ACTIVE', 'INACTIVE', 'PENDING', 'APPROVED'];
    return statuses[index % statuses.length];
  }
  
  return `Sample_${index + 1}`;
}

function generateIntegerValue(colName, index) {
  if (colName.includes('amount') || colName.includes('balance')) {
    return Math.floor(1000 + (index * 1000));
  }
  
  if (colName.includes('rate') || colName.includes('percent')) {
    return Math.floor(5 + (index % 15)); // 5-20%
  }
  
  if (colName.includes('year')) {
    return 2020 + (index % 5); // 2020-2024
  }
  
  if (colName.includes('month')) {
    return (index % 12) + 1; // 1-12
  }
  
  if (colName.includes('day')) {
    return (index % 28) + 1; // 1-28
  }
  
  return index + 1;
}

function generateNumericValue(colName, precision, scale, index) {
  const baseValue = generateIntegerValue(colName, index);
  
  if (scale && scale > 0) {
    return parseFloat(baseValue.toFixed(scale));
  }
  
  return baseValue;
}

function generateFloatValue(colName, index) {
  if (colName.includes('rate') || colName.includes('percent')) {
    return parseFloat((5 + (index * 0.5)).toFixed(2));
  }
  
  return parseFloat((100 + (index * 100.5)).toFixed(2));
}

function generateBooleanValue(colName) {
  if (colName.includes('active') || colName.includes('enabled')) {
    return Math.random() < 0.8; // 80% true
  }
  
  return Math.random() < 0.5;
}

function generateDateValue(colName, index) {
  const baseDate = new Date(2024, 0, 1);
  const daysToAdd = index * 30; // Spread dates across months
  const date = new Date(baseDate.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  return date.toISOString().split('T')[0];
}

function generateTimestampValue(colName, index) {
  const baseDate = new Date(2024, 0, 1);
  const hoursToAdd = index * 24; // Spread timestamps across days
  const timestamp = new Date(baseDate.getTime() + hoursToAdd * 60 * 60 * 1000);
  return timestamp.toISOString();
}

function generateTimeValue(index) {
  const hours = (8 + (index % 10)).toString().padStart(2, '0');
  const minutes = ((index * 15) % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:00`;
}

function generateDefaultValue(tableName, colName, index) {
  return `${tableName}_${colName}_${index + 1}`;
}

async function insertSchemaAwareData(tableName, schema, sampleData) {
  let insertedCount = 0;
  let errorCount = 0;

  for (const record of sampleData) {
    try {
      const keys = Object.keys(record);
      if (keys.length === 0) continue;

      const values = keys.map(key => record[key]);
      const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
      const columnNames = keys.map(key => `"${key}"`).join(', ');

      const insertQuery = `INSERT INTO "${tableName}" (${columnNames}) VALUES (${placeholders})`;
      
      await client.query(insertQuery, values);
      insertedCount++;
      
    } catch (error) {
      errorCount++;
      if (insertedCount === 0 && errorCount === 1) {
        // If first record fails, it's likely a schema issue
        throw new Error(`Schema mismatch: ${error.message}`);
      }
    }
  }

  return {
    success: errorCount === 0,
    recordsInserted: insertedCount,
    errors: errorCount
  };
}

async function showFinalDatabaseStatus() {
  console.log('📊 FINAL DATABASE STATUS AFTER SMART POPULATION:');
  console.log('-' .repeat(70));
  
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
        console.log(`✅ ${row.table_name}: ${count} records`);
        populatedTables++;
      } else {
        console.log(`⚪ ${row.table_name}: 0 records`);
        emptyTables++;
      }
    } catch (error) {
      console.log(`❌ ${row.table_name}: Error accessing table`);
      totalTables++;
    }
  }
  
  console.log('-' .repeat(70));
  console.log(`📊 FINAL SUMMARY: ${totalTables} total tables`);
  console.log(`   ✅ Populated: ${populatedTables} tables (${((populatedTables / totalTables) * 100).toFixed(1)}%)`);
  console.log(`   ⚪ Empty: ${emptyTables} tables (${((emptyTables / totalTables) * 100).toFixed(1)}%)`);
  
  if (populatedTables / totalTables >= 0.8) {
    console.log(`\n🎉 EXCELLENT! Database is ${((populatedTables / totalTables) * 100).toFixed(1)}% populated!`);
  } else if (populatedTables / totalTables >= 0.6) {
    console.log(`\n👍 GOOD! Database is ${((populatedTables / totalTables) * 100).toFixed(1)}% populated!`);
  } else {
    console.log(`\n📈 Database is ${((populatedTables / totalTables) * 100).toFixed(1)}% populated. More work needed.`);
  }
}

smartPopulateAllTables().catch(console.error);