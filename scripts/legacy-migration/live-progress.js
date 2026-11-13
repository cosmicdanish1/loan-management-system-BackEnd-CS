'use strict';

// Live view of the migration for the person checking members in the app.
// Read-only: it only SELECTs from legacy_replay_batch_log and reads the Phase 1 progress file.
//   node scripts/legacy-migration/live-progress.js            (Ctrl-C to stop)
// Prints one line per member as soon as the Phase 2 loan replay has finished that member:
//   DONE   = loan data of that member is final, safe to check in the app
//   FAILED = replay stopped for that member (reason shown); tell me the number
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { targetConfig } = require('./inspect');

const PROGRESS = path.join(__dirname, 'reports', 'all-member-migration-progress.json');
const stamp = () => new Date().toTimeString().slice(0, 8);
const pad = (v, n) => String(v).padEnd(n);

(async () => {
  const pg = new Client(targetConfig());
  await pg.connect();
  let lastId = 0, lastBatches = -1, done = 0, failed = 0;
  console.log(`${stamp()}  watching the migration (Ctrl-C to stop). Phase 1 batches and Phase 2 members appear below.`);
  for (;;) {
    try {
      if (fs.existsSync(PROGRESS)) {
        const n = (JSON.parse(fs.readFileSync(PROGRESS, 'utf8')).completedBatches || []).length;
        if (lastBatches === -1) lastBatches = n; // the file may still hold an older run: only report changes
        if (n !== lastBatches) { console.log(`${stamp()}  PHASE 1  ${n} of 29 member batches copied (300 members each: members, ledger, loans, demand)`); lastBatches = n; }
      }
    } catch { /* file is being written, try next round */ }
    const { rows } = await pg.query(
      `SELECT id, mbno, status, cases_processed, repayments_replayed, consolidations_applied,
              jsonb_array_length(COALESCE(flags,'[]'::jsonb)) AS nflags, left(error_message, 110) AS err
         FROM legacy_replay_batch_log WHERE id > $1 AND dry_run = false ORDER BY id`, [lastId]);
    for (const r of rows) {
      lastId = r.id;
      if (r.status === 'done') {
        done++;
        console.log(`${stamp()}  PHASE 2  DONE    ${pad(r.mbno, 12)} loans=${pad(r.cases_processed, 3)} repayments=${pad(r.repayments_replayed, 4)} consolidations=${pad(r.consolidations_applied, 2)} flags=${r.nflags}   (done ${done}, failed ${failed})`);
      } else {
        failed++;
        console.log(`${stamp()}  PHASE 2  FAILED  ${pad(r.mbno, 12)} ${r.err || r.status}   (done ${done}, failed ${failed})`);
      }
    }
    await new Promise(res => setTimeout(res, 3000));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
