const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_DATABASE || 'EMP_Espat_Society',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'Test@1212',
});

async function generateCompleteDatabaseDocumentation() {
  try {
    await client.connect();
    console.log('📚 GENERATING COMPLETE DATABASE DOCUMENTATION\n');
    console.log('=' .repeat(70));

    const documentation = {
      metadata: await getDatabaseMetadata(),
      tables: await getAllTableDocumentation(),
      relationships: await getDatabaseRelationships(),
      indexes: await getDatabaseIndexes(),
      statistics: await getDatabaseStatistics(),
      generatedAt: new Date().toISOString()
    };

    // Generate multiple output formats
    await generateMarkdownDocumentation(documentation);
    await generateJSONDocumentation(documentation);
    await generateSQLSchema(documentation);
    await generateQuickReference(documentation);

    console.log('\n🎉 DATABASE DOCUMENTATION GENERATION COMPLETE!');
    console.log('📁 Generated Files:');
    console.log('   📄 DATABASE_COMPLETE_DOCUMENTATION.md - Full documentation');
    console.log('   📄 DATABASE_SCHEMA.json - Machine-readable schema');
    console.log('   📄 DATABASE_SCHEMA.sql - SQL schema export');
    console.log('   📄 DATABASE_QUICK_REFERENCE.md - Quick lookup guide');

  } catch (error) {
    console.error('❌ Documentation generation error:', error);
  } finally {
    await client.end();
  }
}

async function getDatabaseMetadata() {
  console.log('📊 Gathering database metadata...');
  
  const dbInfoQuery = `
    SELECT 
      current_database() as database_name,
      current_user as current_user,
      version() as postgresql_version,
      pg_size_pretty(pg_database_size(current_database())) as database_size
  `;

  const schemaInfoQuery = `
    SELECT 
      schemaname,
      COUNT(*) as table_count
    FROM pg_stat_user_tables 
    GROUP BY schemaname
  `;

  const [dbInfo, schemaInfo] = await Promise.all([
    client.query(dbInfoQuery),
    client.query(schemaInfoQuery)
  ]);

  return {
    database: dbInfo.rows[0],
    schemas: schemaInfo.rows
  };
}

async function getAllTableDocumentation() {
  console.log('📋 Documenting all tables...');
  
  const tablesQuery = `
    SELECT table_name
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;

  const tablesResult = await client.query(tablesQuery);
  const tables = {};

  let processedCount = 0;
  for (const row of tablesResult.rows) {
    const tableName = row.table_name;
    
    try {
      tables[tableName] = await getCompleteTableDocumentation(tableName);
      processedCount++;
      
      if (processedCount % 10 === 0) {
        console.log(`   📊 Processed ${processedCount}/${tablesResult.rows.length} tables...`);
      }
    } catch (error) {
      console.log(`   ⚠️  Error documenting ${tableName}: ${error.message}`);
      tables[tableName] = { error: error.message };
    }
  }

  console.log(`   ✅ Completed documentation for ${processedCount} tables`);
  return tables;
}

async function getCompleteTableDocumentation(tableName) {
  // Get basic table info
  const tableInfoQuery = `
    SELECT 
      t.table_name,
      t.table_type,
      obj_description(c.oid) as table_comment
    FROM information_schema.tables t
    LEFT JOIN pg_class c ON c.relname = t.table_name
    WHERE t.table_name = $1 AND t.table_schema = 'public'
  `;

  // Get columns with detailed information
  const columnsQuery = `
    SELECT 
      c.column_name,
      c.ordinal_position,
      c.column_default,
      c.is_nullable,
      c.data_type,
      c.character_maximum_length,
      c.character_octet_length,
      c.numeric_precision,
      c.numeric_scale,
      c.datetime_precision,
      c.udt_name,
      col_description(pgc.oid, c.ordinal_position) as column_comment
    FROM information_schema.columns c
    LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
    WHERE c.table_name = $1 AND c.table_schema = 'public'
    ORDER BY c.ordinal_position
  `;

  // Get constraints
  const constraintsQuery = `
    SELECT 
      tc.constraint_name,
      tc.constraint_type,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.match_option,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
    LEFT JOIN information_schema.constraint_column_usage ccu 
      ON ccu.constraint_name = tc.constraint_name
    LEFT JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
    WHERE tc.table_name = $1 AND tc.table_schema = 'public'
  `;

  // Get indexes
  const indexesQuery = `
    SELECT 
      i.relname as index_name,
      a.attname as column_name,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary,
      ix.indisvalid as is_valid,
      am.amname as index_method
    FROM pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    JOIN pg_am am ON i.relam = am.oid
    WHERE t.relname = $1 AND t.relkind = 'r'
  `;

  // Get table statistics
  const statsQuery = `
    SELECT 
      schemaname,
      tablename,
      attname,
      n_distinct,
      most_common_vals,
      most_common_freqs,
      histogram_bounds
    FROM pg_stats 
    WHERE tablename = $1 AND schemaname = 'public'
  `;

  // Get row count and size
  const sizeQuery = `
    SELECT 
      COUNT(*) as row_count,
      pg_size_pretty(pg_total_relation_size($1)) as total_size,
      pg_size_pretty(pg_relation_size($1)) as table_size
  `;

  try {
    const [tableInfo, columns, constraints, indexes, stats, sizeInfo] = await Promise.all([
      client.query(tableInfoQuery, [tableName]),
      client.query(columnsQuery, [tableName]),
      client.query(constraintsQuery, [tableName]),
      client.query(indexesQuery, [tableName]),
      client.query(statsQuery, [tableName]),
      client.query(`SELECT COUNT(*) as row_count FROM "${tableName}"`)
    ]);

    // Get table size
    const tableSizeResult = await client.query(
      `SELECT pg_size_pretty(pg_total_relation_size($1)) as total_size, pg_size_pretty(pg_relation_size($1)) as table_size`,
      [tableName]
    );

    return {
      info: tableInfo.rows[0] || {},
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      statistics: stats.rows,
      rowCount: parseInt(sizeInfo.rows[0]?.row_count || 0),
      size: tableSizeResult.rows[0] || {}
    };
  } catch (error) {
    throw new Error(`Failed to document table ${tableName}: ${error.message}`);
  }
}

async function getDatabaseRelationships() {
  console.log('🔗 Mapping database relationships...');
  
  const relationshipsQuery = `
    SELECT 
      tc.table_name as source_table,
      kcu.column_name as source_column,
      ccu.table_name as target_table,
      ccu.column_name as target_column,
      tc.constraint_name,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu 
      ON ccu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name
  `;

  const result = await client.query(relationshipsQuery);
  return result.rows;
}

async function getDatabaseIndexes() {
  console.log('📇 Cataloging database indexes...');
  
  const indexesQuery = `
    SELECT 
      t.relname as table_name,
      i.relname as index_name,
      a.attname as column_name,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary,
      am.amname as index_method,
      pg_size_pretty(pg_relation_size(i.oid)) as index_size
    FROM pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    JOIN pg_am am ON i.relam = am.oid
    WHERE t.relkind = 'r'
    ORDER BY t.relname, i.relname
  `;

  const result = await client.query(indexesQuery);
  return result.rows;
}

async function getDatabaseStatistics() {
  console.log('📈 Collecting database statistics...');
  
  try {
    const tableStatsQuery = `
      SELECT 
        schemaname,
        relname as tablename,
        n_tup_ins as inserts,
        n_tup_upd as updates,
        n_tup_del as deletes,
        n_live_tup as live_tuples,
        n_dead_tup as dead_tuples,
        last_vacuum,
        last_autovacuum,
        last_analyze,
        last_autoanalyze
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY n_live_tup DESC
    `;

    const indexStatsQuery = `
      SELECT 
        schemaname,
        relname as tablename,
        indexrelname as indexname,
        idx_tup_read,
        idx_tup_fetch
      FROM pg_stat_user_indexes
      WHERE schemaname = 'public'
      ORDER BY idx_tup_read DESC
    `;

    const [tableStats, indexStats] = await Promise.all([
      client.query(tableStatsQuery),
      client.query(indexStatsQuery)
    ]);

    return {
      tables: tableStats.rows,
      indexes: indexStats.rows
    };
  } catch (error) {
    console.log('   ⚠️  Statistics collection failed, using basic stats');
    return {
      tables: [],
      indexes: []
    };
  }
}

async function generateMarkdownDocumentation(documentation) {
  console.log('📝 Generating Markdown documentation...');
  
  let markdown = `# Complete Database Documentation

## Database Information

**Database:** ${documentation.metadata.database.database_name}  
**PostgreSQL Version:** ${documentation.metadata.database.postgresql_version}  
**Database Size:** ${documentation.metadata.database.database_size}  
**Generated:** ${new Date(documentation.generatedAt).toLocaleString()}  

## Summary Statistics

- **Total Tables:** ${Object.keys(documentation.tables).length}
- **Total Relationships:** ${documentation.relationships.length}
- **Total Indexes:** ${documentation.indexes.length}

---

## Table Documentation

`;

  // Sort tables by name
  const sortedTables = Object.keys(documentation.tables).sort();
  
  for (const tableName of sortedTables) {
    const table = documentation.tables[tableName];
    
    if (table.error) {
      markdown += `### ❌ ${tableName}
**Error:** ${table.error}

`;
      continue;
    }

    markdown += `### 📊 ${tableName}

**Rows:** ${table.rowCount.toLocaleString()}  
**Size:** ${table.size.total_size || 'Unknown'}  

#### Columns

| Column | Type | Nullable | Default | Comment |
|--------|------|----------|---------|---------|
`;

    for (const column of table.columns) {
      const type = column.character_maximum_length 
        ? `${column.data_type}(${column.character_maximum_length})`
        : column.data_type;
      
      markdown += `| ${column.column_name} | ${type} | ${column.is_nullable} | ${column.column_default || '-'} | ${column.column_comment || '-'} |
`;
    }

    if (table.constraints.length > 0) {
      markdown += `
#### Constraints

| Name | Type | Columns | References |
|------|------|---------|------------|
`;
      
      for (const constraint of table.constraints) {
        const reference = constraint.foreign_table_name 
          ? `${constraint.foreign_table_name}.${constraint.foreign_column_name}`
          : '-';
        
        markdown += `| ${constraint.constraint_name} | ${constraint.constraint_type} | ${constraint.column_name || '-'} | ${reference} |
`;
      }
    }

    if (table.indexes.length > 0) {
      markdown += `
#### Indexes

| Name | Columns | Type | Unique | Primary |
|------|---------|------|--------|---------|
`;
      
      const indexGroups = {};
      for (const index of table.indexes) {
        if (!indexGroups[index.index_name]) {
          indexGroups[index.index_name] = {
            columns: [],
            method: index.index_method,
            unique: index.is_unique,
            primary: index.is_primary
          };
        }
        indexGroups[index.index_name].columns.push(index.column_name);
      }

      for (const [indexName, indexInfo] of Object.entries(indexGroups)) {
        markdown += `| ${indexName} | ${indexInfo.columns.join(', ')} | ${indexInfo.method} | ${indexInfo.unique ? '✅' : '❌'} | ${indexInfo.primary ? '✅' : '❌'} |
`;
      }
    }

    markdown += `
---

`;
  }

  // Add relationships section
  markdown += `## Database Relationships

| Source Table | Source Column | Target Table | Target Column | Update Rule | Delete Rule |
|--------------|---------------|--------------|---------------|-------------|-------------|
`;

  for (const rel of documentation.relationships) {
    markdown += `| ${rel.source_table} | ${rel.source_column} | ${rel.target_table} | ${rel.target_column} | ${rel.update_rule} | ${rel.delete_rule} |
`;
  }

  fs.writeFileSync('DATABASE_COMPLETE_DOCUMENTATION.md', markdown);
}

async function generateJSONDocumentation(documentation) {
  console.log('📄 Generating JSON schema...');
  
  fs.writeFileSync(
    'DATABASE_SCHEMA.json', 
    JSON.stringify(documentation, null, 2)
  );
}

async function generateSQLSchema(documentation) {
  console.log('🗃️ Generating SQL schema export...');
  
  let sql = `-- Database Schema Export
-- Generated: ${new Date(documentation.generatedAt).toLocaleString()}
-- Database: ${documentation.metadata.database.database_name}

`;

  const sortedTables = Object.keys(documentation.tables).sort();
  
  for (const tableName of sortedTables) {
    const table = documentation.tables[tableName];
    
    if (table.error) continue;

    sql += `-- Table: ${tableName} (${table.rowCount} rows)
CREATE TABLE IF NOT EXISTS "${tableName}" (
`;

    const columnDefs = [];
    for (const column of table.columns) {
      let colDef = `  "${column.column_name}" ${column.udt_name}`;
      
      if (column.character_maximum_length) {
        colDef += `(${column.character_maximum_length})`;
      }
      
      if (column.is_nullable === 'NO') {
        colDef += ' NOT NULL';
      }
      
      if (column.column_default) {
        colDef += ` DEFAULT ${column.column_default}`;
      }
      
      columnDefs.push(colDef);
    }

    sql += columnDefs.join(',\n');
    sql += `
);

`;

    // Add constraints
    for (const constraint of table.constraints) {
      if (constraint.constraint_type === 'PRIMARY KEY') {
        sql += `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraint.constraint_name}" PRIMARY KEY ("${constraint.column_name}");
`;
      } else if (constraint.constraint_type === 'FOREIGN KEY') {
        sql += `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraint.constraint_name}" FOREIGN KEY ("${constraint.column_name}") REFERENCES "${constraint.foreign_table_name}"("${constraint.foreign_column_name}");
`;
      }
    }

    sql += `
`;
  }

  fs.writeFileSync('DATABASE_SCHEMA.sql', sql);
}

async function generateQuickReference(documentation) {
  console.log('📋 Generating quick reference guide...');
  
  let quickRef = `# Database Quick Reference Guide

## Table Summary

| Table Name | Rows | Size | Primary Key | Description |
|------------|------|------|-------------|-------------|
`;

  const sortedTables = Object.keys(documentation.tables).sort();
  
  for (const tableName of sortedTables) {
    const table = documentation.tables[tableName];
    
    if (table.error) continue;

    const primaryKey = table.constraints
      .filter(c => c.constraint_type === 'PRIMARY KEY')
      .map(c => c.column_name)
      .join(', ') || '-';

    quickRef += `| ${tableName} | ${table.rowCount.toLocaleString()} | ${table.size.total_size || '-'} | ${primaryKey} | ${table.info.table_comment || '-'} |
`;
  }

  quickRef += `

## Key Tables by Category

### Core Business Tables
- **member_master** (${documentation.tables.member_master?.rowCount.toLocaleString() || 0} members)
- **loan_master** (${documentation.tables.loan_master?.rowCount.toLocaleString() || 0} loans)
- **fdmaster** (${documentation.tables.fdmaster?.rowCount.toLocaleString() || 0} fixed deposits)
- **ledger** (${documentation.tables.ledger?.rowCount.toLocaleString() || 0} transactions)

### Configuration Tables
- **headmaster** (${documentation.tables.headmaster?.rowCount.toLocaleString() || 0} account heads)
- **wingmast** (${documentation.tables.wingmast?.rowCount.toLocaleString() || 0} wings)
- **parameter_setting** (${documentation.tables.parameter_setting?.rowCount.toLocaleString() || 0} parameters)

### Security & Access
- **usermaster** (${documentation.tables.usermaster?.rowCount.toLocaleString() || 0} users)
- **userlevelmaster** (${documentation.tables.userlevelmaster?.rowCount.toLocaleString() || 0} user levels)
- **userrights** (${documentation.tables.userrights?.rowCount.toLocaleString() || 0} permissions)

## Most Active Tables (by row count)

`;

  const tablesBySize = sortedTables
    .map(name => ({ name, count: documentation.tables[name]?.rowCount || 0 }))
    .filter(t => !documentation.tables[t.name]?.error)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  for (const table of tablesBySize) {
    quickRef += `- **${table.name}**: ${table.count.toLocaleString()} rows
`;
  }

  quickRef += `

## Foreign Key Relationships

`;

  const relationshipsByTable = {};
  for (const rel of documentation.relationships) {
    if (!relationshipsByTable[rel.source_table]) {
      relationshipsByTable[rel.source_table] = [];
    }
    relationshipsByTable[rel.source_table].push(rel);
  }

  for (const [table, relations] of Object.entries(relationshipsByTable)) {
    quickRef += `### ${table}
`;
    for (const rel of relations) {
      quickRef += `- ${rel.source_column} → ${rel.target_table}.${rel.target_column}
`;
    }
    quickRef += `
`;
  }

  fs.writeFileSync('DATABASE_QUICK_REFERENCE.md', quickRef);
}

generateCompleteDatabaseDocumentation().catch(console.error);