'use strict';
// Builds the member list for the first-due-month reset: real members that have schedule versions (their stored
// first due month is one month late), minus members whose last replay failed (source-data exceptions to be
// reconciled by hand, see migration.md) — those are left exactly as they are.
// Writes reports/reset-first-due-all-<n>.txt and a 30-member pilot list reports/reset-first-due-pilot-30.txt
// (members spread over consolidated / non-consolidated loans).
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { targetConfig, OUT } = require('./inspect');

(async () => {
  const pg = new Client(targetConfig());
  await pg.connect();
  const all = (await pg.query(
    `SELECT DISTINCT sv.mbno::text AS m,
            EXISTS (SELECT 1 FROM loan_schedule_versions s2 WHERE s2.mbno = sv.mbno AND s2.source = 'CONSOLIDATION') AS consolidated
       FROM loan_schedule_versions sv
      WHERE (sv.mbno < 900000000 OR (sv.mbno >= 900017000 AND sv.mbno < 9000000000))
        AND NOT EXISTS (SELECT 1 FROM legacy_replay_batch_log b WHERE trim(b.mbno::text) = trim(sv.mbno::text) AND b.status = 'failed')
      ORDER BY 1`,
  )).rows;
  const failed = (await pg.query(`SELECT trim(mbno::text) AS m FROM legacy_replay_batch_log WHERE status = 'failed'`)).rows.map(r => r.m);
  await pg.end();

  fs.mkdirSync(OUT, { recursive: true });
  const allFile = path.join(OUT, `reset-first-due-all-${all.length}.txt`);
  fs.writeFileSync(allFile, all.map(r => r.m).join('\n') + '\n');
  // pilot: deterministic spread — every Nth member, half consolidated
  const cons = all.filter(r => r.consolidated), plain = all.filter(r => !r.consolidated);
  const pick = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
  const pilot = [...pick(cons, 15), ...pick(plain, 15)].map(r => r.m);
  const pilotFile = path.join(OUT, 'reset-first-due-pilot-30.txt');
  fs.writeFileSync(pilotFile, pilot.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'reset-first-due-excluded-failed.txt'), failed.join('\n') + '\n');
  console.log(JSON.stringify({ members: all.length, consolidated: cons.length, plain: plain.length, pilot: pilot.length, excludedFailed: failed.length, allFile, pilotFile }, null, 2));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
