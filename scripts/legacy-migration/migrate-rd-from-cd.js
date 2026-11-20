'use strict';

// Migration step "RD from CD" (migration-v1.md section 47).
// In the legacy system RD and CD are ONE thing (head L1004; demand_master.RD_Amount is 0 in every row).
// The new app reads a member's RD for loan eligibility / lien / RD interest from rd_balance_events, not from
// member_balances.compulsory_deposit, so a migrated member shows RD = 0. This step gives every member an OPENING
// event equal to the CD balance already in member_balances, plus the monthly amount in rd_member_config.
//
//   node scripts/legacy-migration/migrate-rd-from-cd.js              read-only: prints what it would write
//   node scripts/legacy-migration/migrate-rd-from-cd.js --execute    writes (one transaction)
//   optional: --as-of=YYYY-MM-DD   date of the OPENING events (default: today)
//
// Safe to re-run: it only ever deletes/replaces rows it wrote itself (created_by / set_by = 'legacy-migration').
// A member who already has any other RD event in the current financial year (test data or real use of the RD module)
// is left alone and listed. Nothing is written to the ledger, member_balances or any other table.
const { Client } = require('pg');
const { targetConfig } = require('./inspect');

const TAG = 'legacy-migration';
const EXECUTE = process.argv.includes('--execute');
const asOfArg = (process.argv.find(a => a.startsWith('--as-of=')) || '').slice(8);

(async () => {
  const pg = new Client(targetConfig());
  await pg.connect();
  try {
    const yr = (await pg.query(`SELECT yearcode, to_char(start_date::date, 'YYYY-MM-DD') AS s FROM yearend WHERE start_date <= NOW() AND end_date >= NOW() LIMIT 1`)).rows[0];
    if (!yr) throw new Error('no current financial year in yearend');
    const asOf = asOfArg || new Date().toISOString().slice(0, 10);
    const fyStart = yr.s;

    const { rows: [c] } = await pg.query(`
      SELECT
        (SELECT count(*) FROM member_balances WHERE compulsory_deposit <> 0)                         AS members_with_cd,
        (SELECT count(*) FROM member_balances WHERE compulsory_deposit < 0)                          AS negative_cd,
        (SELECT COALESCE(sum(compulsory_deposit),0) FROM member_balances WHERE compulsory_deposit <> 0) AS total_cd,
        (SELECT count(DISTINCT mbno) FROM rd_balance_events WHERE yearcode = $1 AND created_by <> $2)  AS members_with_other_events,
        (SELECT count(*) FROM rd_balance_events WHERE created_by = $2)                               AS my_old_events,
        (SELECT count(*) FROM rd_member_config WHERE set_by = $2)                                    AS my_old_configs`, [yr.yearcode, TAG]);
    console.log(`Financial year ${yr.yearcode} (starts ${fyStart}); OPENING events dated ${asOf}`);
    console.log(`Members with a CD balance: ${c.members_with_cd} (${c.negative_cd} negative), total ${Number(c.total_cd).toFixed(2)}`);
    console.log(`Members that already have other RD events this year (left alone): ${c.members_with_other_events}`);
    console.log(`Rows from an earlier run of this step (replaced): ${c.my_old_events} events, ${c.my_old_configs} configs`);
    if (!EXECUTE) { console.log('\nRead-only run: nothing written. Add --execute to write.'); return; }

    await pg.query('BEGIN');
    await pg.query(`DELETE FROM rd_balance_events WHERE created_by = $1`, [TAG]);
    await pg.query(`DELETE FROM rd_member_config WHERE set_by = $1`, [TAG]);
    const ev = await pg.query(`
      INSERT INTO rd_balance_events (mbno, yearcode, event_date, event_type, amount, resulting_balance, narration, created_by)
      SELECT mb.mbno::numeric, $1, $2::date, 'OPENING', mb.compulsory_deposit::numeric, mb.compulsory_deposit::numeric,
             'Migrated from legacy compulsory deposit (RD and CD are one head, L1004)', $3
        FROM member_balances mb
       WHERE mb.compulsory_deposit <> 0
         AND NOT EXISTS (SELECT 1 FROM rd_balance_events e WHERE e.mbno = mb.mbno::numeric AND e.yearcode = $1)`,
      [yr.yearcode, asOf, TAG]);
    const cfg = await pg.query(`
      INSERT INTO rd_member_config (mbno, yearcode, monthly_rd_amount, effective_from_date, set_by)
      SELECT f.mbno::numeric, $1, f.cdamt::numeric, $2::date, $3
        FROM fundsmaster f
       WHERE f.cdamt > 0
         AND NOT EXISTS (SELECT 1 FROM rd_member_config g WHERE g.mbno = f.mbno::numeric AND g.yearcode = $1)`,
      [yr.yearcode, fyStart, TAG]);
    // check: every member's RD holdings (event pot) must equal the CD balance, except members left alone
    const { rows: [chk] } = await pg.query(`
      SELECT count(*) AS differing FROM member_balances mb
        JOIN rd_balance_events e ON e.mbno = mb.mbno::numeric AND e.yearcode = $1 AND e.created_by = $2
       WHERE e.resulting_balance <> mb.compulsory_deposit::numeric`, [yr.yearcode, TAG]);
    if (Number(chk.differing) !== 0) throw new Error(`${chk.differing} members differ after the insert; rolled back`);
    await pg.query('COMMIT');
    console.log(`\nWritten: ${ev.rowCount} OPENING events, ${cfg.rowCount} monthly RD configs. Check passed: RD opening = CD balance for every member written.`);
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch { /* not in a transaction */ }
    console.error('FAILED:', e.message); process.exitCode = 1;
  } finally { await pg.end(); }
})();
