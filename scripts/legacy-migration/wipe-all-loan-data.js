'use strict';

/**
 * Wipes ALL loan-related data for EVERY member from the target Postgres DB —
 * a full reset so loan migration can be re-verified from a genuinely clean
 * baseline (no leftover stale legacy_replay_batch_log rows, no partial-write
 * corruption from earlier runs, no consolidated_into_loancaseno pointing at
 * cases that no longer make sense).
 *
 * Explicitly does NOT touch: busrules (business rules), or any non-loan
 * member data (RD, SB, FD, shares, compulsory deposit, etc.).
 *
 * Two categories of tables:
 *  - LOAN-EXCLUSIVE tables: fully cleared (every row deleted). These only
 *    ever hold loan data, so a full delete can't touch anything else.
 *  - MIXED tables: hold loan data alongside unrelated data on the same
 *    table/row. Only the loan-specific slice is removed:
 *      - ledger: rows WHERE acc_type IN ('RLN','ALN','ELN') only (confirmed
 *        these are the only loan type codes present in ledger.acc_type —
 *        no MLN/EDL/FLN rows exist in this database).
 *      - member_balances: only the loan columns are zeroed
 *        (regularloan, regularinstallamt, int_amount, emergency_loan_balance,
 *        einstallamt, eint_amount) — RD/share/SB columns on the same row are
 *        left untouched.
 *    demand_master, transactions, and vouchers are deliberately NOT touched:
 *    demand_master mixes loan installment columns with RD/CD/MD columns on
 *    the same per-member-month row (zeroing them out risks corrupting
 *    derived totals for a table this session's loan verification doesn't
 *    even read from); transactions/vouchers are pure live-app artifacts that
 *    the legacy migration never populates in the first place (confirmed:
 *    neither table appears in migrate-single-member.js's COPY_TABLES list),
 *    so migrated members have no loan-related rows there to remove.
 *
 * Default: dry run (counts what would be removed, transaction rolled back).
 * Commit:  node wipe-all-loan-data.js --execute
 *
 * No backup is taken — test-environment reset tool only, matching the
 * instruction that backups aren't needed here. Do not point at production.
 */
const { Client } = require('pg');
const { targetConfig, pgQuote } = require('./inspect');

const EXECUTE = process.argv.includes('--execute');

const LOAN_EXCLUSIVE_TABLES = [
  'loan_master', 'loan_pending', 'loan_masterhistory', 'loan_product',
  'loan_balance_history', 'loan_repayment_ledger', 'loan_rb_schedule',
  'loan_nominee', 'legacy_replay_batch_log', 'suretymaster',
  'loan_opbal', 'loan_interest_master', 'loan_monthly_balance', 'loan_accounts',
];

const LOAN_MEMBER_BALANCE_COLUMNS = [
  'regularloan', 'regularinstallamt', 'int_amount',
  'emergency_loan_balance', 'einstallamt', 'eint_amount',
];

async function main() {
  const pg = new Client(targetConfig());
  await pg.connect();
  let began = false;
  try {
    const identity = (await pg.query('SELECT current_database() AS database')).rows[0];
    if (identity.database !== 'EMP_Espat_Society') {
      throw new Error(`Refusing unexpected target database: ${identity.database}`);
    }

    await pg.query('BEGIN'); began = true;
    await pg.query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='5min'");

    const summary = [];

    for (const table of LOAN_EXCLUSIVE_TABLES) {
      const exists = (await pg.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [table],
      )).rowCount;
      if (!exists) { summary.push({ table, note: 'table not found, skipped', deleted: 0 }); continue; }
      const result = await pg.query(`DELETE FROM ${pgQuote(table)}`);
      summary.push({ table, deleted: result.rowCount });
    }

    const ledgerResult = await pg.query(`DELETE FROM ledger WHERE acc_type IN ('RLN','ALN','ELN')`);
    summary.push({ table: 'ledger (acc_type RLN/ALN/ELN only)', deleted: ledgerResult.rowCount });

    const setClauses = LOAN_MEMBER_BALANCE_COLUMNS.map(c => `${pgQuote(c)} = 0`).join(', ');
    const mbResult = await pg.query(
      `UPDATE member_balances SET ${setClauses}
       WHERE ${LOAN_MEMBER_BALANCE_COLUMNS.map(c => `COALESCE(${pgQuote(c)}, 0) <> 0`).join(' OR ')}`,
    );
    summary.push({ table: `member_balances (${LOAN_MEMBER_BALANCE_COLUMNS.join(', ')} zeroed only)`, deleted: mbResult.rowCount });

    console.table(summary);
    const total = summary.reduce((n, s) => n + (s.deleted || 0), 0);

    if (EXECUTE) {
      await pg.query('COMMIT'); began = false;
      console.log(`\nCOMMITTED — ${total} rows affected across ${summary.length} tables. demand_master, transactions, vouchers, and busrules were left untouched.`);
    } else {
      await pg.query('ROLLBACK'); began = false;
      console.log(`\nDRY RUN — nothing changed. Would affect ${total} rows across ${summary.length} tables.`);
      console.log('Re-run with --execute to actually wipe.');
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
