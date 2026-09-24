'use strict';

// Read-only inventory. Requires Node, backend's pg/dotenv, and Windows sqlcmd.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const dotenv = require('dotenv');
const BACKEND = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'reports');
const SOURCE = { server: '.\\SQLEXPRESS', database: 'EMP_Espat_Society_dan' };
const EXPECTED_TARGET = 'EMP_Espat_Society';
const msQuote = v => '[' + v.replace(/]/g, ']]') + ']';
const pgQuote = v => '"' + v.replace(/"/g, '""') + '"';

function sourceQuery(sql) {
  const result = spawnSync('sqlcmd', [
    '-S', SOURCE.server, '-d', SOURCE.database, '-E', '-l', '10', '-t', '600',
    '-b', '-r', '1', '-y', '0', '-w', '65535', '-f', '65001',
    '-Q', 'SET NOCOUNT ON; SET LOCK_TIMEOUT 10000; ' + sql,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024, timeout: 620000 });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`sqlcmd terminated by ${result.signal}`);
  if (result.status !== 0 || result.stderr.trim()) {
    throw new Error(`sqlcmd failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const out = result.stdout;
  return JSON.parse(out.replace(/\r?\n/g, '').replace(/^\uFEFF/, '').trim() || '[]');
}

function targetConfig() {
  const envPath = path.join(BACKEND, '.env');
  const env = { ...(fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {}), ...process.env };
  const configPath = process.env.DB_CONFIG_PATH || path.join(BACKEND, 'db-config.json');
  const file = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  const config = {
    host: file.host ?? env.DB_HOST ?? 'localhost',
    port: Number(file.port ?? env.DB_PORT ?? 5432),
    user: file.username ?? env.DB_USERNAME ?? 'postgres',
    password: file.password ?? env.DB_PASSWORD,
    database: file.database ?? env.DB_DATABASE,
    ssl: file.ssl ?? env.DB_SSL === 'true',
    connectionTimeoutMillis: 10000,
    application_name: 'legacy-migration-inspect',
  };
  if (config.database !== EXPECTED_TARGET) throw new Error('Unexpected target database: ' + config.database);
  return config;
}

async function inspect() {
  const pg = new Client(targetConfig());
  await pg.connect();
  try {
    await pg.query("SET default_transaction_read_only=on; SET statement_timeout='120s'; SET lock_timeout='10s'");
    const identity = (await pg.query('SELECT current_database() AS database, current_user AS username, version() AS version')).rows[0];
    const sourceIdentity = sourceQuery("SELECT DB_NAME() AS [database], CAST(SERVERPROPERTY('ProductVersion') AS varchar(50)) AS version, snapshot_isolation_state_desc AS snapshot_isolation FROM sys.databases WHERE name=DB_NAME() FOR JSON PATH")[0];
    const msTables = sourceQuery(`SELECT s.name AS [schema], t.name AS [name], t.object_id AS id
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
      WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name FOR JSON PATH`);
    const msColumns = sourceQuery(`SELECT s.name AS [schema], t.name AS [table], c.name, c.column_id AS ordinal,
      ty.name AS type, c.max_length, c.precision, c.scale, c.is_nullable AS nullable,
      c.is_identity AS [identity], c.is_computed AS computed, dc.definition AS [default], c.collation_name AS collation
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
      JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON c.user_type_id=ty.user_type_id
      LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id
      WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name,c.column_id FOR JSON PATH, INCLUDE_NULL_VALUES`);
    const msIndexes = sourceQuery(`SELECT s.name AS [schema], t.name AS [table], i.name, i.is_primary_key AS pk,
      i.is_unique AS [unique], i.filter_definition AS filter, c.name AS [column], ic.key_ordinal AS ordinal,
      ic.is_included_column AS included FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
      JOIN sys.indexes i ON i.object_id=t.object_id JOIN sys.index_columns ic ON ic.object_id=t.object_id AND ic.index_id=i.index_id
      JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=ic.column_id
      WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name,i.name,ic.key_ordinal FOR JSON PATH, INCLUDE_NULL_VALUES`);
    const msConstraints = sourceQuery(`SELECT s.name AS [schema], t.name AS [table], o.name, o.type_desc AS type,
      cc.definition, fk.is_disabled, fk.is_not_trusted, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS referenced_schema,
      OBJECT_NAME(fk.referenced_object_id) AS referenced_table FROM sys.objects o
      JOIN sys.tables t ON t.object_id=o.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
      LEFT JOIN sys.check_constraints cc ON cc.object_id=o.object_id LEFT JOIN sys.foreign_keys fk ON fk.object_id=o.object_id
      WHERE t.is_ms_shipped=0 AND o.type IN ('F','C','PK','UQ') ORDER BY s.name,t.name,o.name FOR JSON PATH, INCLUDE_NULL_VALUES`);
    const msObjects = sourceQuery(`SELECT s.name AS [schema], o.name, o.type_desc AS type FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 AND o.type IN ('P','V','FN','IF','TF','TR')
      ORDER BY o.type_desc,s.name,o.name FOR JSON PATH`);
    const pgTables = (await pg.query(`SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' ORDER BY 1,2`)).rows;
    const pgColumns = (await pg.query(`SELECT table_schema AS schema,table_name AS "table",column_name AS name,
      ordinal_position AS ordinal,data_type AS type,udt_name,character_maximum_length AS max_length,
      numeric_precision AS precision,numeric_scale AS scale,(is_nullable='YES') AS nullable,
      column_default AS "default",is_identity,identity_generation,is_generated,generation_expression,collation_name AS collation
      FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,ordinal_position`)).rows;
    const pgConstraints = (await pg.query(`SELECT n.nspname AS schema,c.relname AS "table",con.conname AS name,
      con.contype AS type,pg_get_constraintdef(con.oid) AS definition,con.convalidated AS validated,
      con.condeferrable AS deferrable,con.condeferred AS deferred,
      ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum ORDER BY k.ord)::text[] AS columns
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3`)).rows;
    const pgIndexes = (await pg.query(`SELECT schemaname AS schema,tablename AS "table",indexname AS name,indexdef AS definition
      FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3`)).rows;
    const pgTriggers = (await pg.query(`SELECT n.nspname AS schema,c.relname AS "table",t.tgname AS name,
      pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal ORDER BY 1,2,3`)).rows;
    console.log('Connected to both databases; counting ' + msTables.length + ' source and ' + pgTables.length + ' target tables.');
    for (const [index,t] of msTables.entries()) {
      t.rows = sourceQuery(`SELECT CONVERT(varchar(30),COUNT_BIG(*)) AS rows FROM ${msQuote(t.schema)}.${msQuote(t.name)} FOR JSON PATH`)[0].rows;
      if ((index+1)%50===0) console.log('Source tables counted: '+(index+1));
    }
    for (const t of pgTables) {
      t.rows = (await pg.query(`SELECT count(*)::text AS rows FROM ${pgQuote(t.schema)}.${pgQuote(t.name)}`)).rows[0].rows;
    }
    const source = { identity: sourceIdentity, tables: msTables, columns: msColumns, indexes: msIndexes, constraints: msConstraints, objects: msObjects };
    const target = { identity, tables: pgTables, columns: pgColumns, constraints: pgConstraints, indexes: pgIndexes, triggers: pgTriggers };
    const comparisons = compare(source, target);
    const report = { generatedAt: new Date().toISOString(), consistency: 'Live read-only observations, NOT a single cross-database snapshot.', source, target, comparisons };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'schema-comparison.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT, 'schema-comparison.md'), markdown(report));
    console.log(JSON.stringify(summary(report), null, 2));
    return report;
  } finally { await pg.end(); }
}

function compare(source, target) {
  const result = [];
  const used = new Set();
  for (const s of source.tables) {
    const candidates = target.tables.filter(t => t.schema === 'public' && t.name.toLowerCase() === s.name.toLowerCase());
    const sourceColumns = source.columns.filter(c => c.schema === s.schema && c.table === s.name);
    if (candidates.length !== 1) { result.push({ source: s, status: 'source-only', sourceColumns }); continue; }
    const t = candidates[0]; used.add(t);
    const targetColumns = target.columns.filter(c => c.schema === t.schema && c.table === t.name);
    const matched = sourceColumns.map(sc => ({ source: sc, target: targetColumns.find(tc => tc.name.toLowerCase() === sc.name.toLowerCase()) })).filter(c => c.target);
    const sourceOnly = sourceColumns.filter(sc => !matched.some(m => m.source === sc));
    const targetOnly = targetColumns.filter(tc => !matched.some(m => m.target === tc));
    const requiredMissing = targetOnly.filter(c => !c.nullable && c.default === null && c.is_identity === 'NO' && c.is_generated === 'NEVER');
    const sourceKey = source.indexes.filter(i => i.schema === s.schema && i.table === s.name && i.pk && !i.included).sort((a,b)=>a.ordinal-b.ordinal).map(i=>i.column);
    const targetKey = target.constraints.find(c => c.schema === t.schema && c.table === t.name && c.type === 'p')?.columns || [];
    if (!Array.isArray(targetKey)) throw new Error('Unexpected key metadata for '+t.name);
    result.push({ source:s,target:t,status:'needs-review',matched,sourceOnly,targetOnly,requiredMissing,sourceKey,targetKey });
  }
  for (const t of target.tables) if (!used.has(t)) result.push({ target:t,status:'target-only' });
  return result;
}

function summary(r) {
  const common = r.comparisons.filter(c=>c.source && c.target);
  return {
    sourceTables:r.source.tables.length,targetTables:r.target.tables.length,commonTables:common.length,
    sourceOnly:r.comparisons.filter(c=>c.status==='source-only').length,targetOnly:r.comparisons.filter(c=>c.status==='target-only').length,
    sourceRows:r.source.tables.reduce((n,t)=>n+BigInt(t.rows),0n).toString(),targetRows:r.target.tables.reduce((n,t)=>n+BigInt(t.rows),0n).toString(),
    commonWithExistingTargetRows:common.filter(c=>BigInt(c.target.rows)>0n).length,
    commonWithoutSourcePk:common.filter(c=>!c.sourceKey.length).length,commonWithoutTargetPk:common.filter(c=>!c.targetKey.length).length,
    sourceOnlyColumns:common.reduce((n,c)=>n+c.sourceOnly.length,0),targetOnlyColumns:common.reduce((n,c)=>n+c.targetOnly.length,0),
    tablesWithRequiredMissingColumns:common.filter(c=>c.requiredMissing.length).map(c=>({table:c.target.name,columns:c.requiredMissing.map(x=>x.name)})),
  };
}

function markdown(r) {
  const esc = s => String(s ?? '').replace(/\|/g,'\\|').replace(/[\r\n]/g,' ');
  const rows = r.comparisons.map(c=>`| ${esc(c.source ? c.source.schema+'.'+c.source.name : '-')} | ${esc(c.target ? c.target.schema+'.'+c.target.name : '-')} | ${c.source?.rows ?? '-'} | ${c.target?.rows ?? '-'} | ${c.matched?.length ?? '-'} | ${esc(c.sourceOnly?.map(x=>x.name).join(', ') || '-')} | ${esc(c.targetOnly?.map(x=>x.name).join(', ') || '-')} |`);
  return `# Legacy migration inventory\n\nGenerated: ${r.generatedAt}\n\n${r.consistency}\n\nThis report is an inventory, not approval of mappings or proof of migration readiness. Same names do not establish business equivalence. No database writes performed.\n\n\`\`\`json\n${JSON.stringify(summary(r),null,2)}\n\`\`\`\n\n| SQL Server | PostgreSQL | Source rows | Target rows | Shared columns | Legacy-only columns | Target-only columns |\n|---|---|---:|---:|---:|---|---|\n${rows.join('\n')}\n\nFull column types, precision, defaults, keys, indexes, constraints and triggers are in schema-comparison.json. Row counts may change while applications are active.\n`;
}

if (require.main === module) inspect().catch(e => { console.error(e.message); process.exitCode=1; });
module.exports = { inspect, compare, summary, sourceQuery, targetConfig, msQuote, pgQuote, SOURCE, OUT };
