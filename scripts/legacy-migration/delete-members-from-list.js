'use strict';

/**
 * Deletes EVERY row belonging to the members in a list from the target Postgres DB, so they can be migrated
 * again from the legacy source (Phase 1 + Phase 2). List version of delete-single-member.js: same dynamic
 * discovery of member-scoped tables, same loan_nominee handling, chunked into transactions.
 *
 * Only real migrated members are accepted (real legacy members: see isRealMember). Application test members (SLOTTEST / SLOTMATRIX
 * 9999962xxx, synthetic 9000000xx ...) are refused outright, never deleted by this script.
 *
 * Default: dry run (counts what would go, every chunk rolled back).
 * Commit:  MBNO_FILE=<file> node delete-members-from-list.js --execute
 *
 * No backup is taken here — take one first (this DB holds test data, but keep the habit; see migration.md).
 */
const fs = require('node:fs');
const { Client } = require('pg');
const { targetConfig, pgQuote } = require('./inspect');

const EXECUTE = process.argv.includes('--execute');
const MBNO_FILE = process.env.MBNO_FILE;
const CHUNK = 150;
const MEMBER_COLUMNS = ['mbno', 'memberno', 'member_no', 'memberid'];
// Real legacy members are < 900,000,000 and 900,017,000..8,999,999,999 (1,387 legacy members have 9-digit numbers starting 9);
// test members are 900,000,001..900,016,999 (synthetic) and >= 9,000,000,000 (SLOTTEST / SLOTMATRIX).
const isRealMember = (m) => Number(m) < 900000000 || (Number(m) >= 900017000 && Number(m) < 9000000000);

async function main() {
  if (!MBNO_FILE) throw new Error('Set MBNO_FILE to a text file with one member number per line.');
  const members = [...new Set(fs.readFileSync(MBNO_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  const bad = members.filter(m => !/^\d+$/.test(m) || !isRealMember(m));
  if (bad.length) throw new Error(`Refusing: ${bad.length} entries are not real migrated member numbers (must be a real legacy member number, see isRealMember), e.g. ${bad.slice(0, 5).join(', ')}`);

  const pg = new Client(targetConfig());
  await pg.connect();
  try {
    const identity = (await pg.query('SELECT current_database() AS database')).rows[0];
    if (identity.database !== 'EMP_Espat_Society') throw new Error(`Refusing unexpected target database: ${identity.database}`);

    const tables = (await pg.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND lower(column_name) = ANY($1::text[]) ORDER BY table_name`,
      [MEMBER_COLUMNS],
    )).rows;
    console.log(`${members.length} members, ${tables.length} member-scoped tables. Mode: ${EXECUTE ? 'EXECUTE' : 'dry run'}`);

    const totals = new Map();
    for (let i = 0; i < members.length; i += CHUNK) {
      const chunk = members.slice(i, i + CHUNK);
      await pg.query('BEGIN');
      try {
        await pg.query("SET LOCAL lock_timeout='20s'; SET LOCAL statement_timeout='10min'");
        const cases = (await pg.query(
          `SELECT DISTINCT loancaseno::text AS c FROM loan_master WHERE trim(mbno::text) = ANY($1::text[])`, [chunk],
        )).rows.map(r => r.c);
        for (const t of tables) {
          const r = await pg.query(`DELETE FROM ${pgQuote(t.table_name)} WHERE trim(${pgQuote(t.column_name)}::text) = ANY($1::text[])`, [chunk]);
          if (r.rowCount > 0) totals.set(t.table_name, (totals.get(t.table_name) || 0) + r.rowCount);
        }
        if (cases.length) {
          const exists = (await pg.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='loan_nominee'`)).rowCount;
          if (exists) {
            const r = await pg.query(`DELETE FROM loan_nominee WHERE loancaseno::text = ANY($1::text[])`, [cases]);
            if (r.rowCount > 0) totals.set('loan_nominee (via loancaseno)', (totals.get('loan_nominee (via loancaseno)') || 0) + r.rowCount);
          }
        }
        await pg.query(EXECUTE ? 'COMMIT' : 'ROLLBACK');
      } catch (e) {
        await pg.query('ROLLBACK').catch(() => {});
        throw e;
      }
      if ((i / CHUNK) % 5 === 0) console.log(`  chunk ${Math.min(i + CHUNK, members.length)} / ${members.length} ${EXECUTE ? 'deleted' : 'counted'}`);
    }
    console.table([...totals].map(([table, rows]) => ({ table, rows })));
    const total = [...totals.values()].reduce((a, b) => a + b, 0);
    console.log(EXECUTE ? `COMMITTED - deleted ${total} rows for ${members.length} members.` : `DRY RUN - would delete ${total} rows for ${members.length} members.`);
  } finally {
    await pg.end();
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
