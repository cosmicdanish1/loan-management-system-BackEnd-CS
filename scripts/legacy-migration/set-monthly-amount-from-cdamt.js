'use strict';

// Migration step "monthly RD/CD amount from fundsmaster.cdamt" (RD/CD stage 2).
//
// WHAT IT DOES: for every ACTIVE real member who has a monthly compulsory deposit in fundsmaster.cdamt (> 0) and no
// monthly amount yet in the app, it writes ONE row to rd_member_config for the current financial year:
//     monthly_rd_amount = fundsmaster.cdamt, effective_from_date = --effective-from (default: 1st of this month),
//     set_by = 'LEGACY MIGRATION'.
// That is exactly what "RD/CD Member Setup" would hold if someone had typed the amount, so RD/CD Repayment shows what is
// due and the dashboard RD dues, the RD/CD reports and Member Complete Detail see the amount.
//
// WHAT IT DOES NOT DO (on purpose): no ledger rows, no member_balances change, no instalment rows (rd_installment_ledger),
// no interest timeline (rd_balance_events), no year-closing record. Money and balances are the derive step's job.
//
//   node scripts/legacy-migration/set-monthly-amount-from-cdamt.js                         read-only: prints what it would write
//   node scripts/legacy-migration/set-monthly-amount-from-cdamt.js --execute               writes (one transaction)
//   optional: --effective-from=YYYY-MM-DD   first month whose payroll is imported in the new app (default: 1st of this month)
//
// Safe to re-run: a member who already has ANY monthly amount for the year (typed in the app, or set by a demand import)
// is never touched. It never updates or deletes a row. Active members only; test members (9999900000+) are skipped.
const { Client } = require('pg');
const { targetConfig } = require('./inspect');

const TAG = 'LEGACY MIGRATION';
const EXECUTE = process.argv.includes('--execute');
const effArg = (process.argv.find(a => a.startsWith('--effective-from=')) || '').slice(17);

(async () => {
  const pg = new Client(targetConfig());
  await pg.connect();
  try {
    const yr = (await pg.query(`SELECT yearcode, to_char(start_date::date,'YYYY-MM-DD') s, to_char(end_date::date,'YYYY-MM-DD') e FROM yearend WHERE start_date <= NOW() AND end_date >= NOW() LIMIT 1`)).rows[0];
    if (!yr) throw new Error('no current financial year in yearend');
    const now = new Date();
    const effective = effArg || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective) || effective < yr.s || effective > yr.e) {
      throw new Error(`--effective-from ${effective} is not inside financial year ${yr.yearcode} (${yr.s} to ${yr.e})`);
    }
    const minRule = Number((await pg.query(`SELECT value AS config_value FROM system_configs WHERE key = 'RULE_RD_MIN_MONTHLY_AMOUNT' AND "isActive" = true LIMIT 1`).catch(() => ({ rows: [] }))).rows[0]?.config_value) || 200;

    const cand = (await pg.query(`
      SELECT m.mbno::numeric AS mbno, f.cdamt::float AS cdamt, b.rd_amt::float AS rd_amt, (b.mbno IS NULL) AS no_balance_row
        FROM member_master m
        JOIN (SELECT mbno::numeric AS mn, MAX(cdamt) AS cdamt FROM fundsmaster GROUP BY 1) f ON f.mn = m.mbno::numeric
        LEFT JOIN member_balances b ON b.mbno::numeric = m.mbno::numeric
       WHERE m.isactive = 'Y' AND f.cdamt > 0 AND m.mbno::numeric < 9999900000
         AND NOT EXISTS (SELECT 1 FROM rd_member_config c WHERE c.mbno::numeric = m.mbno::numeric AND c.yearcode = $1)
       ORDER BY m.mbno::numeric`, [yr.yearcode])).rows;
    const already = Number((await pg.query(`SELECT count(DISTINCT mbno)::int n FROM rd_member_config WHERE yearcode = $1 AND mbno::numeric < 9999900000`, [yr.yearcode])).rows[0].n);

    const total = cand.reduce((s, r) => s + r.cdamt, 0);
    const below = cand.filter(r => r.cdamt < minRule);
    const differs = cand.filter(r => r.rd_amt != null && Math.abs(r.rd_amt - r.cdamt) >= 0.01);
    const noBal = cand.filter(r => r.no_balance_row);
    console.log(`Financial year ${yr.yearcode} (${yr.s} to ${yr.e}); amounts effective from ${effective}`);
    console.log(`Active real members already having a monthly amount (left alone): ${already}`);
    console.log(`Members to set up: ${cand.length}; total monthly amount ₹${total.toLocaleString('en-IN')}`);
    console.log(`  below the Business Rules minimum (₹${minRule}) - written as the legacy says, listed: ${below.length}${below.length ? ' -> ' + below.map(r => `${r.mbno}:₹${r.cdamt}`).join(', ') : ''}`);
    console.log(`  member_balances.rd_amt differs from cdamt (cdamt is used), listed: ${differs.length}${differs.length ? ' -> first 10: ' + differs.slice(0, 10).map(r => `${r.mbno}: cdamt ₹${r.cdamt} vs rd_amt ₹${r.rd_amt}`).join('; ') : ''}`);
    console.log(`  have no member_balances row yet (the balance derive step creates it): ${noBal.length}`);

    if (!EXECUTE) { console.log('\nREAD-ONLY: nothing written. Add --execute to write.'); return; }

    await pg.query('BEGIN');
    let written = 0;
    for (const r of cand) {
      const res = await pg.query(
        `INSERT INTO rd_member_config (mbno, yearcode, monthly_rd_amount, effective_from_date, set_by)
         SELECT $1, $2, $3, $4::date, $5
          WHERE NOT EXISTS (SELECT 1 FROM rd_member_config WHERE mbno::numeric = $1::numeric AND yearcode = $2)`,
        [r.mbno, yr.yearcode, r.cdamt, effective, TAG]);
      written += res.rowCount;
    }
    // independent re-check: every member now has exactly the amount we meant, nothing else changed
    const chk = (await pg.query(`SELECT count(*)::int n, COALESCE(sum(monthly_rd_amount),0)::float t FROM rd_member_config WHERE set_by = $1 AND yearcode = $2`, [TAG, yr.yearcode])).rows[0];
    if (chk.n !== written || Math.abs(chk.t - total) > 0.01) { await pg.query('ROLLBACK'); throw new Error(`re-check failed (rows ${chk.n} vs ${written}, total ${chk.t} vs ${total}); rolled back`); }
    await pg.query('COMMIT');
    console.log(`\nWRITTEN: ${written} monthly amounts (re-check passed: ${chk.n} rows, ₹${chk.t.toLocaleString('en-IN')}).`);
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch { /* none open */ }
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
})();
