'use strict';

// Migration step "derive the member deposit balances" (migration-v1.md sections 19 and 47; decisions Q37 and Q38).
// The legacy system never stored these balances: each is the opening balance in fundsmaster plus the member's net ledger
// movement (credits minus debits) on the head, and member_balances held only a 2019 snapshot, wrong for nine in ten members.
//   compulsory_deposit (the RD/CD, one deposit) = cdopbal    + net L1004
//   shares                                      = shareopbal + net L1001
//   frsbalance (FRS 1 + FRS 2)                  = (mdopbal + net L1002) + (md1_opbal + net L1045)
//
//   node scripts/legacy-migration/derive-cd-balance.js              read-only: prints what would change
//   node scripts/legacy-migration/derive-cd-balance.js --execute    writes, in one transaction
//
// Writes ONLY those three columns (and rd_amt, the monthly amount, on rows it creates). Loan columns are never touched.
// Members that have a balance source but no member_balances row get a minimal row, the same shape the app itself inserts.
// After writing, every member is checked against an independent query; any difference rolls everything back.
const { Client } = require('pg');
const { targetConfig } = require('./inspect');
const EXECUTE = process.argv.includes('--execute');

const net = code => `SELECT mbno::numeric AS mbno,
                    SUM(CASE WHEN trans_type = 'CR' THEN trans_amt WHEN trans_type = 'DR' THEN -trans_amt ELSE 0 END) AS net
               FROM ledger WHERE code = '${code}' GROUP BY mbno::numeric`;

const DERIVED = `
  WITH n1004 AS (${net('L1004')}), n1001 AS (${net('L1001')}), n1002 AS (${net('L1002')}), n1045 AS (${net('L1045')}),
       ids AS (SELECT mbno::numeric AS mbno FROM fundsmaster UNION SELECT mbno FROM n1004 UNION SELECT mbno FROM n1001
               UNION SELECT mbno FROM n1002 UNION SELECT mbno FROM n1045),
       d AS (SELECT i.mbno,
                    COALESCE(f.cdopbal, 0)::numeric + COALESCE(a.net, 0)::numeric AS cd,
                    COALESCE(f.shareopbal, 0)::numeric + COALESCE(b.net, 0)::numeric AS shares,
                    (COALESCE(f.mdopbal, 0)::numeric + COALESCE(c.net, 0)::numeric) + (COALESCE(f.md1_opbal, 0)::numeric + COALESCE(e.net, 0)::numeric) AS frs,
                    f.cdamt::numeric AS cdamt
               FROM ids i
               LEFT JOIN fundsmaster f ON f.mbno::numeric = i.mbno
               LEFT JOIN n1004 a ON a.mbno = i.mbno LEFT JOIN n1001 b ON b.mbno = i.mbno
               LEFT JOIN n1002 c ON c.mbno = i.mbno LEFT JOIN n1045 e ON e.mbno = i.mbno
              WHERE i.mbno IN (SELECT mbno::numeric FROM member_master))`;

(async () => {
  const pg = new Client(targetConfig());
  await pg.connect();
  try {
    const differs = `(ROUND(COALESCE(b.compulsory_deposit,0)::numeric,2) <> ROUND(d.cd,2)
                  OR ROUND(COALESCE(b.shares,0)::numeric,2) <> ROUND(d.shares,2)
                  OR ROUND(COALESCE(b.frsbalance,0)::numeric,2) <> ROUND(d.frs,2))`;
    const { rows: [c] } = await pg.query(`${DERIVED}
      SELECT count(*) AS members,
             count(*) FILTER (WHERE b.mbno IS NOT NULL AND ${differs}) AS to_update,
             count(*) FILTER (WHERE b.mbno IS NULL AND (d.cd <> 0 OR d.shares <> 0 OR d.frs <> 0 OR d.cdamt > 0)) AS to_insert,
             count(*) FILTER (WHERE b.mbno IS NOT NULL AND NOT ${differs}) AS already_right,
             COALESCE(sum(d.cd),0) AS total_cd, COALESCE(sum(d.shares),0) AS total_shares, COALESCE(sum(d.frs),0) AS total_frs
        FROM d LEFT JOIN member_balances b ON b.mbno::numeric = d.mbno`);
    console.log(`Members with a balance source: ${c.members}`);
    console.log(`Balance rows to correct: ${c.to_update}; rows to create: ${c.to_insert}; already right: ${c.already_right}`);
    console.log(`Derived totals: CD/RD ${Number(c.total_cd).toFixed(2)}, shares ${Number(c.total_shares).toFixed(2)}, FRS ${Number(c.total_frs).toFixed(2)}`);
    if (!EXECUTE) { console.log('\nRead-only run: nothing written. Add --execute to write.'); return; }

    await pg.query('BEGIN');
    const up = await pg.query(`${DERIVED}
      UPDATE member_balances b SET compulsory_deposit = d.cd, shares = d.shares, frsbalance = d.frs
        FROM d WHERE b.mbno::numeric = d.mbno AND ${differs}`);
    const ins = await pg.query(`${DERIVED}
      INSERT INTO member_balances (mbno, officeno, compulsory_deposit, shares, frsbalance, rd_amt)
      SELECT d.mbno::float8, m.officeno, d.cd, d.shares, d.frs, COALESCE(d.cdamt, 0)
        FROM d JOIN member_master m ON m.mbno::numeric = d.mbno
       WHERE (d.cd <> 0 OR d.shares <> 0 OR d.frs <> 0 OR d.cdamt > 0)
         AND NOT EXISTS (SELECT 1 FROM member_balances b WHERE b.mbno::numeric = d.mbno)`);
    // independent check: recompute from the base tables and compare with what was just written
    const { rows: [chk] } = await pg.query(`${DERIVED}
      SELECT count(*) AS wrong FROM d LEFT JOIN member_balances b ON b.mbno::numeric = d.mbno
       WHERE (d.cd <> 0 OR d.shares <> 0 OR d.frs <> 0 OR b.mbno IS NOT NULL) AND ${differs}`);
    if (Number(chk.wrong) !== 0) throw new Error(`${chk.wrong} members still differ after the write; rolled back`);
    await pg.query('COMMIT');
    console.log(`\nWritten: ${up.rowCount} balances corrected, ${ins.rowCount} rows created. Check passed for every member.`);
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch { /* none open */ }
    console.error('FAILED:', e.message); process.exitCode = 1;
  } finally { await pg.end(); }
})();
