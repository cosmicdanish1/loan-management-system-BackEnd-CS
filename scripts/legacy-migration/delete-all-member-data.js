'use strict';

/**
 * Deletes all legacy-member-scoped rows from the target Postgres DB, across
 * the same 15 tables migrate-all-members.js writes to. This is the reset
 * companion to that script — for wiping a test run clean so the migration
 * can be exercised again from scratch.
 *
 * It is scoped to the exact same member universe migrate-all-members.js
 * discovers (member_master + any id that only appears in a child table), so
 * it can NEVER touch a row belonging to a member id that isn't part of the
 * legacy population — e.g. manually created test accounts, or genuine new
 * members signed up in the live app, are left alone. This is NOT a TRUNCATE.
 *
 * Default: dry run (counts what would be deleted, transaction rolled back).
 * Commit:  node delete-all-member-data.js --execute --confirm=DELETE-ALL-MEMBER-DATA
 *
 * A full pg_dump backup is always taken before a real delete.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const dotenv = require('dotenv');
const { targetConfig, pgQuote, OUT } = require('./inspect');
const { discoverAllLegacyMembers, COPY_TABLES } = require('./migrate-all-members');

const EXECUTE = process.argv.includes('--execute');
const CONFIRM_ARG = process.argv.find(a => a.startsWith('--confirm='));
const CONFIRMED = CONFIRM_ARG && CONFIRM_ARG.split('=')[1] === 'DELETE-ALL-MEMBER-DATA';
const BACKEND = path.resolve(__dirname, '../..');
const REPORT_FILE = path.join(OUT, `delete-all-member-data-${EXECUTE ? 'result' : 'dry-run'}.json`);

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
  const destination = path.join(dir, `pre-delete-all-member-data-${stamp}.dump`);
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync(exe, ['-Fc', '--no-owner', '--no-acl', '-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '-f', destination], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: config.password || '' }, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`pg_dump failed: ${result.stderr || result.stdout}`);
  const bytes = fs.statSync(destination).size;
  if (bytes < 1024) throw new Error(`Backup is unexpectedly small: ${destination} (${bytes} bytes)`);
  return { path: destination, bytes };
}

async function ownerColumnFor(pg, spec) {
  const row = (await pg.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND lower(column_name)=lower($2)`,
    [spec.target, spec.member],
  )).rows[0];
  if (!row) throw new Error(`${spec.target}: no column matching ${spec.member}`);
  return row.column_name;
}

async function main() {
  if (EXECUTE && !CONFIRMED) {
    throw new Error('Refusing to execute without --confirm=DELETE-ALL-MEMBER-DATA (dry run is the default and safe to run without it).');
  }

  console.log('Discovering the legacy member universe (same logic as migrate-all-members.js)...');
  const members = discoverAllLegacyMembers();
  console.log(`Found ${members.length} legacy member ids. This run will only ever touch rows for these ids.`);

  const pg = new Client(targetConfig());
  let backup = null;
  if (EXECUTE) {
    console.log('Creating full PostgreSQL backup...');
    backup = backupTarget();
    console.log(`Backup verified: ${backup.path} (${backup.bytes} bytes)`);
  }
  await pg.connect();
  const report = { startedAt: new Date().toISOString(), mode: EXECUTE ? 'execute' : 'dry-run', memberCount: members.length, backup, tables: [] };
  let began = false;
  try {
    const identity = (await pg.query('SELECT current_database() AS database, current_user AS username')).rows[0];
    if (identity.database !== 'EMP_Espat_Society') throw new Error(`Refusing unexpected target ${identity.database}`);

    await pg.query('BEGIN'); began = true;
    await pg.query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='10min'");
    await pg.query("SELECT pg_advisory_xact_lock(hashtext('legacy-all-member-migration'))");

    for (const spec of COPY_TABLES) {
      const ownerCol = await ownerColumnFor(pg, spec);
      const before = (await pg.query(`SELECT count(*)::int AS n FROM ${pgQuote(spec.target)}
        WHERE trim(${pgQuote(ownerCol)}::text) = ANY($1::text[])`, [members])).rows[0].n;
      const result = await pg.query(`DELETE FROM ${pgQuote(spec.target)}
        WHERE trim(${pgQuote(ownerCol)}::text) = ANY($1::text[])`, [members]);
      report.tables.push({ table: spec.target, matchedBeforeDelete: before, deleted: result.rowCount });
      console.log(`${spec.target}: ${EXECUTE ? 'deleted' : 'would delete'} ${result.rowCount} rows`);
    }

    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(OUT, { recursive: true });
    if (EXECUTE) {
      await pg.query('COMMIT'); began = false;
      fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
      console.log(`\nCOMMITTED. Deleted ${report.tables.reduce((n, t) => n + t.deleted, 0)} rows across ${report.tables.length} tables for ${members.length} members.`);
    } else {
      await pg.query('ROLLBACK'); began = false;
      fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
      console.log(`\nDRY RUN — nothing deleted. Would remove ${report.tables.reduce((n, t) => n + t.deleted, 0)} rows across ${report.tables.length} tables.`);
      console.log('Re-run with --execute --confirm=DELETE-ALL-MEMBER-DATA to actually delete.');
    }
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
