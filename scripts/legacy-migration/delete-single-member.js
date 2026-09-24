'use strict';

/**
 * Deletes EVERY row belonging to ONE member from the target Postgres DB.
 *
 * Unlike delete-all-member-data.js (which wipes the entire legacy member
 * universe across a fixed 15-table list), this is scoped to a single member
 * id and discovers its tables dynamically: every public table carrying an
 * mbno / memberno / member_no / memberId column, plus loan-case-scoped
 * children (loan_nominee) resolved through that member's own loan cases.
 *
 * Dynamic discovery matters here because the app has grown tables the
 * original 15-table legacy copy list never knew about (loan_repayment_ledger,
 * loan_rb_schedule, rd_balance_events, legacy_replay_batch_log, ...). A
 * hardcoded list would silently leave those behind and the member would come
 * back half-deleted.
 *
 * Default: dry run (counts what would go, transaction rolled back).
 * Commit:  node delete-single-member.js <mbno> --execute
 *
 * No backup is taken — this is a test-environment reset tool. Do not point
 * it at production.
 *
 * Usage:
 *   node delete-single-member.js 610026861            (dry run)
 *   node delete-single-member.js 610026861 --execute  (commit)
 */
const { Client } = require('pg');
const { targetConfig, pgQuote } = require('./inspect');

const EXECUTE = process.argv.includes('--execute');
const MEMBER = process.argv.slice(2).find(a => !a.startsWith('--'));

const MEMBER_COLUMNS = ['mbno', 'memberno', 'member_no', 'memberid'];

function assertValidMember() {
  if (!MEMBER || !/^\d+$/.test(MEMBER)) {
    throw new Error('Usage: node delete-single-member.js <mbno> [--execute]  (mbno must be numeric)');
  }
}

/** Every public table with a member-identifying column, discovered live so a
 *  newly-added table is never silently skipped. */
async function discoverMemberTables(pg) {
  const rows = (await pg.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND lower(column_name) = ANY($1::text[])
      ORDER BY table_name`,
    [MEMBER_COLUMNS],
  )).rows;
  return rows.map(r => ({ table: r.table_name, column: r.column_name }));
}

async function main() {
  assertValidMember();

  const pg = new Client(targetConfig());
  await pg.connect();
  let began = false;
  try {
    const identity = (await pg.query('SELECT current_database() AS database')).rows[0];
    if (identity.database !== 'EMP_Espat_Society') {
      throw new Error(`Refusing unexpected target database: ${identity.database}`);
    }

    await pg.query('BEGIN'); began = true;
    await pg.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='5min'");

    // Capture this member's loan cases BEFORE loan_master is deleted, so
    // case-scoped children can still be resolved afterwards.
    const loanCases = (await pg.query(
      `SELECT DISTINCT loancaseno::text AS c FROM loan_master WHERE trim(mbno::text) = $1`,
      [MEMBER],
    )).rows.map(r => r.c);

    const targets = await discoverMemberTables(pg);
    console.log(`Member ${MEMBER}: found ${targets.length} member-scoped tables, ${loanCases.length} loan case(s).`);

    let total = 0;
    const summary = [];
    for (const t of targets) {
      const result = await pg.query(
        `DELETE FROM ${pgQuote(t.table)} WHERE trim(${pgQuote(t.column)}::text) = $1`,
        [MEMBER],
      );
      if (result.rowCount > 0) {
        summary.push({ table: t.table, deleted: result.rowCount });
        total += result.rowCount;
      }
    }

    // Loan-case-scoped children that carry no member column of their own.
    if (loanCases.length) {
      for (const child of ['loan_nominee']) {
        const exists = (await pg.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [child],
        )).rowCount;
        if (!exists) continue;
        const result = await pg.query(
          `DELETE FROM ${pgQuote(child)} WHERE loancaseno::text = ANY($1::text[])`, [loanCases],
        );
        if (result.rowCount > 0) {
          summary.push({ table: `${child} (via loancaseno)`, deleted: result.rowCount });
          total += result.rowCount;
        }
      }
    }

    console.table(summary);

    if (EXECUTE) {
      await pg.query('COMMIT'); began = false;
      console.log(`\nCOMMITTED — deleted ${total} rows across ${summary.length} tables for member ${MEMBER}.`);
    } else {
      await pg.query('ROLLBACK'); began = false;
      console.log(`\nDRY RUN — nothing deleted. Would remove ${total} rows across ${summary.length} tables for member ${MEMBER}.`);
      console.log('Re-run with --execute to actually delete.');
    }
  } catch (error) {
    if (began) await pg.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await pg.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { main };
