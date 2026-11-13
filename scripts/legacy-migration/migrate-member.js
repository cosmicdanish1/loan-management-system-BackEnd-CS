'use strict';
/**
 * One-command migration of ONE member (Phase 1 + reset of old replay output + Phase 2).
 *
 *   node scripts/legacy-migration/migrate-member.js 610031839             DRY RUN (writes nothing)
 *   node scripts/legacy-migration/migrate-member.js 610031839 --execute   real run
 *
 * Several members: pass a text file (one mbno per line) with --file=path  (Phase 1 runs member by member).
 * Run from backend/. Reads legacy via sqlcmd (read only); writes to the Postgres in backend/.env.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const fileArg = args.find(a => a.startsWith('--file='));
const members = fileArg
  ? fs.readFileSync(fileArg.split('=')[1], 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  : args.filter(a => /^\d+$/.test(a));
if (!members.length) { console.error('Usage: node scripts/legacy-migration/migrate-member.js <mbno> [--execute]   (or --file=list.txt)'); process.exit(1); }

const dir = __dirname, backend = path.resolve(dir, '../..');
const run = (script, scriptArgs, env = {}) => spawnSync(process.execPath, [path.join(dir, script), ...scriptArgs], { cwd: backend, stdio: 'inherit', env: { ...process.env, ...env } }).status;

(async () => {
  console.log(EXECUTE ? '=== EXECUTE ===' : '=== DRY RUN (nothing is written; add --execute to commit) ===');
  for (const m of members) {
    console.log(`\n--- Phase 1: copy member ${m} ---`);
    if (run('migrate-single-member.js', [m, ...(EXECUTE ? ['--execute'] : [])], { SKIP_BACKUP: '1' }) !== 0) { console.error('Phase 1 failed, stopping.'); process.exit(1); }
  }
  const list = path.join(dir, 'reports', 'migrate-member-list.txt');
  fs.mkdirSync(path.dirname(list), { recursive: true });
  fs.writeFileSync(list, members.join('\n') + '\n');
  if (EXECUTE) {
    // Phase 1 resets loan_master etc., but old replay output (and the "done" mark) would make Phase 2 skip the member.
    require('dotenv').config({ path: path.join(backend, '.env') });
    const { Client } = require('pg');
    const c = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
    await c.connect(); await c.query('BEGIN');
    for (const t of ['loan_repayment_ledger', 'loan_schedule_versions', 'loan_rb_schedule', 'loan_payment_flags', 'legacy_replay_batch_log']) {
      const r = await c.query(`DELETE FROM ${t} WHERE mbno::text = ANY($1::text[])`, [members]);
      console.log(`reset ${t}: ${r.rowCount} old row(s) of these members removed`);
    }
    await c.query('COMMIT'); await c.end();
  }
  console.log(`\n--- Phase 2: replay ${EXECUTE ? '(live)' : '(dry run)'} ---`);
  const env = { MBNO_FILE: list };
  if (EXECUTE) { env.DRY_RUN = 'false'; env.CONFIRM_LIVE_RUN = 'yes-i-mean-it'; }
  const code = run('run-phase2.js', [], env);
  console.log(code === 0 ? '\nFinished. Check "Flags raised" above; the SOP says which flags are normal.' : `\nPhase 2 exited with ${code}`);
  process.exit(code);
})().catch(e => { console.error(e.message); process.exit(1); });
