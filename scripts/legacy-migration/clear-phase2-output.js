'use strict';

// Clears the OLD Phase 2 output of the members in a list, so Phase 2 can run for them again from a clean start.
//   node scripts/legacy-migration/clear-phase2-output.js <list.txt> [--execute]      (dry run without --execute)
// Same five tables that migrate-member.js clears for one member. Touches nothing else (not loan_master, not the ledger, not users).
const fs = require('node:fs');
const { Client } = require('pg');
const { targetConfig } = require('./inspect');

const file = process.argv[2];
const EXECUTE = process.argv.includes('--execute');
if (!file || file.startsWith('--')) { console.error('Usage: node clear-phase2-output.js <list.txt> [--execute]'); process.exit(1); }
const members = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const TABLES = ['loan_repayment_ledger', 'loan_schedule_versions', 'loan_rb_schedule', 'loan_payment_flags', 'legacy_replay_batch_log'];

(async () => {
  const c = new Client(targetConfig());
  await c.connect();
  await c.query('BEGIN');
  try {
    for (const t of TABLES) {
      const r = await c.query(`DELETE FROM ${t} WHERE mbno::text = ANY($1::text[])`, [members]);
      console.log(`${t}: ${r.rowCount} rows ${EXECUTE ? 'deleted' : 'would be deleted'}`);
    }
    if (EXECUTE) { await c.query('COMMIT'); console.log(`Committed for ${members.length} members.`); }
    else { await c.query('ROLLBACK'); console.log('DRY RUN: rolled back.'); }
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
