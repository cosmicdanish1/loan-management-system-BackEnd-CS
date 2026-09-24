'use strict';

/**
 * Single-member SQL Server -> PostgreSQL migration.
 *
 * Migrates one member's rows across all member-scoped tables. Default: dry
 * run (extraction + insert + verification, transaction rolled back).
 * Commit: node migrate-single-member.js <mbno> --execute
 *
 * Same safety model as migrate-all-members.js, scoped to one member:
 *  - Source (SQL Server) is read-only throughout.
 *  - Before touching the member's rows in a table, compares the CURRENT
 *    target row count for that member against what legacy holds. If target
 *    already has MORE rows than legacy (the live app wrote data legacy
 *    never had), that table is SKIPPED for this member and reported instead
 *    of being overwritten.
 *  - Verified after insert by row count AND a SHA-256 fingerprint of the
 *    row contents (source vs. what was actually read back from the target).
 *  - Execute mode takes a full pg_dump backup before opening the transaction.
 *  - Re-running for the same member is idempotent (delete-then-reinsert).
 *
 * Usage:
 *   node migrate-single-member.js 610033194            (dry run)
 *   node migrate-single-member.js 610033194 --execute  (commit)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client, types: pgTypes } = require('pg');
const dotenv = require('dotenv');
const { sourceQuery, targetConfig, msQuote, pgQuote, OUT } = require('./inspect');

// Preserve timestamp-without-time-zone text exactly rather than applying the
// workstation timezone during verification.
pgTypes.setTypeParser(1114, value => value);
pgTypes.setTypeParser(1082, value => value);

const EXECUTE = process.argv.includes('--execute');
const MEMBER = process.argv.slice(2).find(a => !a.startsWith('--'));
const BACKEND = path.resolve(__dirname, '../..');
const INSERT_BATCH = 200;
const REPORT_FILE = path.join(OUT, `single-member-migration-${EXECUTE ? 'result' : 'dry-run'}.json`);

const COPY_TABLES = [
  { source: 'BANK_CHEQ_MASTER', target: 'bank_cheq_master', member: 'MBNO' },
  { source: 'DEMAND_MASTER', target: 'demand_master', member: 'MBNO' },
  { source: 'DEMAND_MASTERDelete', target: 'demand_masterdelete', member: 'MBNO' },
  { source: 'FRS', target: 'frs', member: 'MBNO' },
  { source: 'FUNDSMASTER', target: 'fundsmaster', member: 'MBNO' },
  { source: 'LEDGER', target: 'ledger', member: 'MBNO' },
  { source: 'LEDGER_DATA', target: 'ledger_data', member: 'MBNO' },
  { source: 'LOAN_balance_history', target: 'loan_balance_history', member: 'mbno' },
  { source: 'LOAN_MASTER', target: 'loan_master', member: 'MBNO' },
  { source: 'LOAN_MASTERHISTORY', target: 'loan_masterhistory', member: 'MBNO' },
  { source: 'LOAN_PENDING', target: 'loan_pending', member: 'MBNO' },
  { source: 'LOAN_PRODUCT', target: 'loan_product', member: 'MBNo' },
  { source: 'Member_Balances', target: 'member_balances', member: 'MbNo' },
  { source: 'member_master', target: 'member_master', member: 'MBNO' },
  { source: 'MemberCategory', target: 'membercategory', member: 'MBNO' },
];

function effectiveEnv() {
  const file = path.join(BACKEND, '.env');
  return { ...(fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {}), ...process.env };
}

function backupTarget() {
  const env = effectiveEnv();
  const config = targetConfig();
  const exe = env.PG_DUMP_PATH || 'pg_dump';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKEND, 'backups');
  const destination = path.join(dir, `pre-single-member-migration-${MEMBER}-${stamp}.dump`);
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync(exe, ['-Fc', '--no-owner', '--no-acl', '-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '-f', destination], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: config.password || '' }, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`pg_dump failed: ${result.stderr || result.stdout}`);
  const bytes = fs.statSync(destination).size;
  if (bytes < 1024) throw new Error(`Backup is unexpectedly small: ${destination} (${bytes} bytes)`);
  return { path: destination, bytes };
}

async function metadata(pg, spec) {
  const source = sourceQuery(`SELECT c.name,ty.name AS type,c.column_id AS ordinal
    FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id
    JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE t.name=N'${spec.source.replace(/'/g, "''")}'
    ORDER BY c.column_id FOR JSON PATH`);
  const target = (await pg.query(`SELECT column_name AS name,data_type AS type,udt_name,
    numeric_precision AS precision,numeric_scale AS scale,ordinal_position AS ordinal
    FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [spec.target])).rows;
  const targetMap = new Map(target.map(c => [c.name.toLowerCase(), c]));
  const columns = source.map(s => ({ source: s, target: targetMap.get(s.name.toLowerCase()) })).filter(x => x.target);
  if (!columns.length) throw new Error(`No shared columns for ${spec.source}`);
  if (columns.length !== source.length) throw new Error(`${spec.source}: source columns missing from target: ${source.filter(s => !targetMap.has(s.name.toLowerCase())).map(s => s.name).join(', ')}`);
  return columns;
}

function sourceExpression(column) {
  const c = msQuote(column.source.name), alias = msQuote(column.target.name);
  if (['numeric', 'decimal', 'money', 'smallmoney', 'bigint'].includes(column.source.type)) return `CONVERT(varchar(100),${c}) AS ${alias}`;
  if (['datetime', 'datetime2', 'smalldatetime', 'date', 'time'].includes(column.source.type)) return `CONVERT(varchar(40),${c},126) AS ${alias}`;
  return `${c} AS ${alias}`;
}

function extractRows(spec, columns) {
  const select = columns.map(sourceExpression).join(',');
  return sourceQuery(`SELECT ${select} FROM ${msQuote('dbo')}.${msQuote(spec.source)}
    WHERE TRY_CAST(${msQuote(spec.member)} AS bigint) = ${MEMBER} FOR JSON PATH, INCLUDE_NULL_VALUES`);
}

function converted(value, column) {
  if (value === null || value === undefined) return null;
  if (column.target.type === 'bytea' && typeof value === 'string') return Buffer.from(value, 'base64');
  return value;
}

async function insertRows(pg, spec, columns, rows) {
  const names = columns.map(c => c.target.name);
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const batch = rows.slice(start, start + INSERT_BATCH), values = [];
    const tuples = batch.map(row => '(' + names.map((name, colIndex) => {
      values.push(converted(row[name], columns[colIndex]));
      return '$' + values.length;
    }).join(',') + ')');
    await pg.query(`INSERT INTO ${pgQuote(spec.target)} (${names.map(pgQuote).join(',')}) VALUES ${tuples.join(',')}`, values);
  }
}

function normalized(value, column) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  const type = column.target.type;
  if (['numeric', 'decimal', 'smallint', 'integer', 'bigint'].includes(type)) {
    let s = String(value).trim().replace(/^\+/, '');
    if (/^-?\d+(\.\d+)?$/.test(s)) s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  if (['real', 'double precision'].includes(type)) return Number(value);
  if (type === 'timestamp without time zone' || type === 'date') return String(value).replace(' ', 'T').replace(/\.0+$/, '');
  return value;
}

function fingerprint(rows, columns) {
  const records = rows.map(row => columns.map(c => normalized(row[c.target.name], c)));
  records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function ownerColumn(columns, spec) {
  const owner = columns.find(c => c.source.name.toLowerCase() === spec.member.toLowerCase());
  if (!owner) throw new Error(`${spec.source}: member column is not shared`);
  return owner.target.name;
}

async function targetRows(pg, spec, columns, ownerCol) {
  return (await pg.query(`SELECT ${columns.map(c => pgQuote(c.target.name)).join(',')} FROM ${pgQuote(spec.target)}
    WHERE trim(${pgQuote(ownerCol)}::text) = $1`, [MEMBER])).rows;
}

function assertValidMember() {
  if (!MEMBER || !/^\d+$/.test(MEMBER)) {
    throw new Error('Usage: node migrate-single-member.js <mbno> [--execute]  (mbno must be numeric)');
  }
}

function existsInLegacy() {
  for (const spec of COPY_TABLES) {
    const n = sourceQuery(`SELECT COUNT_BIG(*) AS n FROM ${msQuote('dbo')}.${msQuote(spec.source)}
      WHERE TRY_CAST(${msQuote(spec.member)} AS bigint) = ${MEMBER} FOR JSON PATH`)[0].n;
    if (Number(n) > 0) return true;
  }
  return false;
}

async function main() {
  assertValidMember();
  console.log(`Checking legacy for member ${MEMBER}...`);
  if (!existsInLegacy()) throw new Error(`Member ${MEMBER} has no rows in any legacy table. Nothing to migrate.`);

  const pg = new Client(targetConfig());
  let backup = null;
  if (EXECUTE) {
    console.log('Creating full PostgreSQL backup...');
    backup = backupTarget();
    console.log(`Backup verified: ${backup.path} (${backup.bytes} bytes)`);
  }
  await pg.connect();
  const report = { startedAt: new Date().toISOString(), mode: EXECUTE ? 'execute' : 'dry-run', member: MEMBER, backup, tables: [], flagged: [] };
  let began = false;
  try {
    const identity = (await pg.query('SELECT current_database() AS database, current_user AS username')).rows[0];
    if (identity.database !== 'EMP_Espat_Society') throw new Error(`Refusing unexpected target ${identity.database}`);

    await pg.query('BEGIN'); began = true;
    await pg.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='2min'");
    await pg.query("SELECT pg_advisory_xact_lock(hashtext('legacy-all-member-migration'))");

    for (const spec of COPY_TABLES) {
      const columns = await metadata(pg, spec);
      const ownerCol = ownerColumn(columns, spec);
      const sourceRows = extractRows(spec, columns);

      const existingTarget = (await pg.query(`SELECT count(*)::int AS n FROM ${pgQuote(spec.target)}
        WHERE trim(${pgQuote(ownerCol)}::text) = $1`, [MEMBER])).rows[0].n;

      if (existingTarget > sourceRows.length) {
        report.flagged.push({ table: spec.target, sourceRows: sourceRows.length, targetRows: existingTarget, reason: 'target already has more rows than legacy holds; skipped to avoid overwriting non-legacy data' });
        report.tables.push({ table: spec.target, skipped: true, deleted: 0, inserted: 0 });
        console.log(`${spec.target}: SKIPPED (target has ${existingTarget} rows, legacy has ${sourceRows.length}) — flagged for review`);
        continue;
      }

      const deleted = (await pg.query(`DELETE FROM ${pgQuote(spec.target)} WHERE trim(${pgQuote(ownerCol)}::text) = $1`, [MEMBER])).rowCount;
      await insertRows(pg, spec, columns, sourceRows);
      const copied = await targetRows(pg, spec, columns, ownerCol);
      const sourceHash = fingerprint(sourceRows, columns), targetHash = fingerprint(copied, columns);
      if (copied.length !== sourceRows.length || sourceHash !== targetHash) {
        throw new Error(`${spec.target}: verification failed source=${sourceRows.length}/${sourceHash} target=${copied.length}/${targetHash}`);
      }
      report.tables.push({ table: spec.target, deleted, inserted: sourceRows.length, sha256: sourceHash });
      console.log(`${spec.target}: deleted ${deleted}, inserted and verified ${sourceRows.length}`);
    }

    await pg.query(`UPDATE member_master SET full_name=trim(concat_ws(' ',f_name,m_name,l_name)) WHERE mbno::text = $1`, [MEMBER]);

    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(OUT, { recursive: true });
    if (EXECUTE) {
      await pg.query('COMMIT'); began = false;
      fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
      console.log(`\nCOMMITTED ${report.tables.reduce((n, t) => n + t.inserted, 0)} rows for member ${MEMBER}.`);
    } else {
      await pg.query('ROLLBACK'); began = false;
      fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
      console.log(`\nDRY RUN PASSED and rolled back ${report.tables.reduce((n, t) => n + t.inserted, 0)} rows for member ${MEMBER}.`);
    }
    if (report.flagged.length) console.log(`WARNING: ${report.flagged.length} table(s) skipped — target already had more rows than legacy. See report "flagged".`);
    console.log(`Report written to ${REPORT_FILE}`);
  } catch (error) {
    if (began) await pg.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await pg.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { main };
