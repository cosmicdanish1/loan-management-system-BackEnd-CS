'use strict';

/**
 * Full-population SQL Server -> PostgreSQL member migration.
 *
 * Migrates every member found in the legacy DB (member_master, plus any
 * member id that only appears in a child table) across all member-scoped
 * tables. Default: dry run (extraction + verification, transaction rolled
 * back). Commit: node migrate-all-members.js --execute
 *
 * Safety model:
 *  - Source (SQL Server) is read-only throughout.
 *  - Work is chunked into member batches, each its own transaction, so a
 *    crash mid-run never loses already-committed batches. Re-running is
 *    idempotent per member per table.
 *  - Before touching any member's rows in a table, this script compares the
 *    CURRENT target row count for that member against what legacy holds.
 *    If target already has MORE rows than legacy (meaning the live app has
 *    written data for that member that legacy never had), that member is
 *    SKIPPED for that table and flagged in the report instead of being
 *    overwritten. Nothing is ever deleted "just in case."
 *  - Every batch is verified after insert by row count AND a SHA-256
 *    fingerprint of the row contents (source vs. what was actually read
 *    back from the target), matching the pattern already used by
 *    migrate-members.js for the 15-member pilot.
 *  - Execute mode takes a full pg_dump backup before opening any transaction.
 *  - Progress is persisted after every committed batch to
 *    reports/all-member-migration-progress.json. Re-run with --resume to
 *    skip batches already recorded as committed.
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
const RESUME = process.argv.includes('--resume');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split('=')[1]) : null;
// EXCLUDE_MBNO_FILE: a plain text file, one mbno per line, of members to
// skip entirely from this run — e.g. members whose loan history has an
// unresolved data-quality issue (concurrent same-type loans with no
// consolidation event in the source) that needs manual reconciliation
// before their loan data should be migrated at all.
const EXCLUDE_MBNO_FILE = process.env.EXCLUDE_MBNO_FILE;
// MBNO_FILE: the inverse of EXCLUDE_MBNO_FILE — a plain text file, one mbno
// per line, of the ONLY members to include in this run (everyone else is
// skipped). For a small, targeted test batch rather than a full population
// run.
const MBNO_FILE = process.env.MBNO_FILE;
const BACKEND = path.resolve(__dirname, '../..');
const INSERT_BATCH = 1000;
const MEMBER_BATCH_SIZE = 300;
const PROGRESS_FILE = path.join(OUT, 'all-member-migration-progress.json');
const REPORT_FILE = path.join(OUT, EXECUTE ? 'all-member-migration-result.json' : 'all-member-migration-dry-run.json');

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
  const destination = path.join(dir, `pre-all-member-migration-${stamp}.dump`);
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync(exe, ['-Fc', '--no-owner', '--no-acl', '-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '-f', destination], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: config.password || '' }, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`pg_dump failed: ${result.stderr || result.stdout}`);
  const bytes = fs.statSync(destination).size;
  if (bytes < 1024) throw new Error(`Backup is unexpectedly small: ${destination} (${bytes} bytes)`);
  return { path: destination, bytes };
}

// Every distinct member id in the legacy database: member_master plus any id
// that only ever shows up in a child table, so nothing is dropped just
// because member_master itself is missing a row for it.
function discoverAllLegacyMembers() {
  const ids = new Set();
  for (const spec of COPY_TABLES) {
    const rows = sourceQuery(
      `SELECT DISTINCT CONVERT(varchar(30),TRY_CAST(${msQuote(spec.member)} AS bigint)) AS member
       FROM ${msQuote('dbo')}.${msQuote(spec.source)}
       WHERE TRY_CAST(${msQuote(spec.member)} AS bigint) IS NOT NULL FOR JSON PATH`,
    );
    for (const r of rows) ids.add(r.member);
  }
  return [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
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

function extractRows(spec, columns, memberIdsSql) {
  const select = columns.map(sourceExpression).join(',');
  return sourceQuery(`SELECT ${select} FROM ${msQuote('dbo')}.${msQuote(spec.source)}
    WHERE TRY_CAST(${msQuote(spec.member)} AS bigint) IN (${memberIdsSql}) FOR JSON PATH, INCLUDE_NULL_VALUES`);
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

// Order-independent multiset fingerprint: hash each row individually, then
// combine with BigInt addition (not XOR — XOR of a value with itself is 0,
// which would blind the check to duplicate-count mismatches; addition has no
// such cancellation). This avoids ever sorting or JSON.stringify-ing the
// full row set as one array/string, which dominated runtime on large
// tables (LEDGER etc.) at scale. The existing explicit `.length` comparison
// at the call site already catches count mismatches independently — this
// hash only needs to catch same-count/different-content corruption.
function fingerprint(rows, columns) {
  let sum = 0n;
  for (const row of rows) {
    const canon = columns.map(c => normalized(row[c.target.name], c));
    const digest = crypto.createHash('sha256').update(JSON.stringify(canon)).digest();
    sum += BigInt('0x' + digest.toString('hex'));
  }
  return sum.toString(16);
}

function ownerColumn(columns, spec) {
  const owner = columns.find(c => c.source.name.toLowerCase() === spec.member.toLowerCase());
  if (!owner) throw new Error(`${spec.source}: member column is not shared`);
  return owner.target.name;
}

async function targetCountsByMember(pg, spec, ownerCol, memberIds) {
  const rows = (await pg.query(
    `SELECT trim(${pgQuote(ownerCol)}::text) AS member, count(*)::int AS n FROM ${pgQuote(spec.target)}
     WHERE trim(${pgQuote(ownerCol)}::text)=ANY($1::text[]) GROUP BY 1`, [memberIds],
  )).rows;
  return new Map(rows.map(r => [r.member, r.n]));
}

async function targetRows(pg, spec, columns, ownerCol, memberIds) {
  if (!memberIds.length) return [];
  return (await pg.query(`SELECT ${columns.map(c => pgQuote(c.target.name)).join(',')} FROM ${pgQuote(spec.target)}
    WHERE trim(${pgQuote(ownerCol)}::text)=ANY($1::text[])`, [memberIds])).rows;
}

function loadProgress() {
  if (!RESUME || !fs.existsSync(PROGRESS_FILE)) return { completedBatches: [] };
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
}

function saveProgress(progress) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function processBatch(pg, batchIndex, memberIds, columnsByTable) {
  const memberIdsSql = memberIds.join(',');
  const batchReport = { batchIndex, memberCount: memberIds.length, tables: [], flagged: [] };
  await pg.query('BEGIN');
  await pg.query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='10min'");
  await pg.query("SELECT pg_advisory_xact_lock(hashtext('legacy-all-member-migration'))");
  try {
    for (const spec of COPY_TABLES) {
      const columns = columnsByTable.get(spec.target);
      const ownerCol = ownerColumn(columns, spec);
      const sourceRows = extractRows(spec, columns, memberIdsSql);

      const sourceByMember = new Map();
      for (const row of sourceRows) {
        const key = String(row[ownerCol]).trim();
        (sourceByMember.get(key) || sourceByMember.set(key, []).get(key)).push(row);
      }
      const existingTargetCounts = await targetCountsByMember(pg, spec, ownerCol, memberIds);

      const safeMembers = [];
      for (const id of memberIds) {
        const sCount = (sourceByMember.get(id) || []).length;
        const tCount = existingTargetCounts.get(id) || 0;
        if (tCount > sCount) {
          batchReport.flagged.push({ table: spec.target, member: id, sourceRows: sCount, targetRows: tCount, reason: 'target already has more rows than legacy holds; skipped to avoid overwriting non-legacy data' });
        } else {
          safeMembers.push(id);
        }
      }

      const safeSourceRows = safeMembers.flatMap(id => sourceByMember.get(id) || []);
      let deleted = 0;
      if (safeMembers.length) {
        deleted = (await pg.query(`DELETE FROM ${pgQuote(spec.target)} WHERE trim(${pgQuote(ownerCol)}::text)=ANY($1::text[])`, [safeMembers])).rowCount;
        await insertRows(pg, spec, columns, safeSourceRows);
      }
      const copied = await targetRows(pg, spec, columns, ownerCol, safeMembers);
      const sourceHash = fingerprint(safeSourceRows, columns), targetHash = fingerprint(copied, columns);
      if (copied.length !== safeSourceRows.length || sourceHash !== targetHash) {
        throw new Error(`${spec.target} batch ${batchIndex}: verification failed source=${safeSourceRows.length}/${sourceHash} target=${copied.length}/${targetHash}`);
      }
      batchReport.tables.push({ table: spec.target, deleted, inserted: safeSourceRows.length, skippedMembers: memberIds.length - safeMembers.length, sha256: sourceHash });
    }

    await pg.query(`UPDATE member_master SET full_name=trim(concat_ws(' ',f_name,m_name,l_name)) WHERE mbno::text=ANY($1::text[])`, [memberIds]);

    if (EXECUTE) {
      await pg.query('COMMIT');
    } else {
      await pg.query('ROLLBACK');
    }
    return batchReport;
  } catch (error) {
    await pg.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const pg = new Client(targetConfig());
  let backup = null;
  if (EXECUTE && !process.env.SKIP_BACKUP) {
    console.log('Creating full PostgreSQL backup...');
    backup = backupTarget();
    console.log(`Backup verified: ${backup.path} (${backup.bytes} bytes)`);
  } else if (EXECUTE) {
    console.log('SKIP_BACKUP set — no PostgreSQL backup taken (per explicit instruction: this is test data).');
  }
  await pg.connect();
  try {
    const identity = (await pg.query('SELECT current_database() AS database, current_user AS username')).rows[0];
    if (identity.database !== 'EMP_Espat_Society') throw new Error(`Refusing unexpected target ${identity.database}`);

    console.log('Discovering every legacy member id (member_master + any child-table-only ids)...');
    let allMembers = discoverAllLegacyMembers();
    console.log(`Found ${allMembers.length} distinct legacy member ids across all tables.`);
    if (EXCLUDE_MBNO_FILE) {
      const excluded = new Set(fs.readFileSync(EXCLUDE_MBNO_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      const before = allMembers.length;
      allMembers = allMembers.filter(m => !excluded.has(m));
      console.log(`EXCLUDE_MBNO_FILE: excluded ${before - allMembers.length} of ${excluded.size} listed members (${allMembers.length} remain).`);
    }
    if (MBNO_FILE) {
      const wanted = new Set(fs.readFileSync(MBNO_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      allMembers = allMembers.filter(m => wanted.has(m));
      console.log(`MBNO_FILE: restricted to ${allMembers.length} of ${wanted.size} listed members (matched against the discovered legacy member set).`);
    }
    if (LIMIT) { allMembers = allMembers.slice(0, LIMIT); console.log(`--limit=${LIMIT}: restricting to first ${allMembers.length} member ids (testing only; never use --limit with --execute for a real migration).`); }

    console.log('Loading table schemas once (reused across all batches instead of re-querying every batch)...');
    const columnsByTable = new Map();
    for (const spec of COPY_TABLES) columnsByTable.set(spec.target, await metadata(pg, spec));

    const batches = chunk(allMembers, MEMBER_BATCH_SIZE);
    const progress = loadProgress();
    const done = new Set(progress.completedBatches.map(b => b.batchIndex));
    const report = {
      startedAt: new Date().toISOString(), mode: EXECUTE ? 'execute' : 'dry-run',
      totalMembers: allMembers.length, batchSize: MEMBER_BATCH_SIZE, totalBatches: batches.length,
      backup, batches: progress.completedBatches.slice(), flagged: progress.completedBatches.flatMap(b => b.flagged || []),
    };

    for (let i = 0; i < batches.length; i++) {
      if (done.has(i)) { console.log(`Batch ${i + 1}/${batches.length}: already completed, skipping (--resume).`); continue; }
      console.log(`Batch ${i + 1}/${batches.length}: processing ${batches[i].length} members...`);
      const batchReport = await processBatch(pg, i, batches[i], columnsByTable);
      report.batches.push(batchReport);
      report.flagged.push(...batchReport.flagged);
      progress.completedBatches.push(batchReport);
      saveProgress(progress);
      const inserted = batchReport.tables.reduce((n, t) => n + t.inserted, 0);
      console.log(`Batch ${i + 1}/${batches.length}: ${EXECUTE ? 'committed' : 'verified and rolled back'} ${inserted} rows across ${batchReport.tables.length} tables. Flagged: ${batchReport.flagged.length}.`);
    }

    report.finishedAt = new Date().toISOString();
    report.totalsByTable = COPY_TABLES.map(spec => ({
      table: spec.target,
      inserted: report.batches.reduce((n, b) => n + (b.tables.find(t => t.table === spec.target)?.inserted || 0), 0),
      deleted: report.batches.reduce((n, b) => n + (b.tables.find(t => t.table === spec.target)?.deleted || 0), 0),
      skippedMembers: report.batches.reduce((n, b) => n + (b.tables.find(t => t.table === spec.target)?.skippedMembers || 0), 0),
    }));
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n${EXECUTE ? 'EXECUTE RUN COMPLETE' : 'DRY RUN COMPLETE'}.`);
    console.log(`Members: ${allMembers.length}. Flagged (skipped, needs manual review): ${report.flagged.length}.`);
    console.log(`Report written to ${REPORT_FILE}`);
    if (report.flagged.length) console.log('WARNING: some member/table combinations were skipped because target already had more rows than legacy. See report "flagged" section.');
  } finally {
    await pg.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { main, discoverAllLegacyMembers, COPY_TABLES };
