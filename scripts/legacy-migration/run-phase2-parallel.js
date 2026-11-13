'use strict';

// PARALLEL PHASE 2 RUNNER (separate from run-phase2.js, which is not used or changed here).
//
// Starts several worker processes of `src/scripts/phase2/bulk_ledger_replay_parallel.ts` (an independent copy of the
// Phase 2 replay with the same logic). Every worker gets its own slice of the member list, so no two workers touch the
// same member. It prints one line per member as soon as that member is finished.
//
//   node scripts/legacy-migration/run-phase2-parallel.js --members=<file> [--workers=4] [--redo] --execute
//
// Without --execute it only prints how the members would be split (nothing runs, nothing is written).
// Members already `done` in legacy_replay_batch_log are left out unless --redo is given (then clear their old
// replay output first). Per-worker logs: scripts/legacy-migration/reports/phase2-parallel/worker-N.log
// Measured 2026-11-13: 4 workers about 2.8x faster than one; 8 workers gave no further gain on this machine.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { targetConfig } = require('./inspect');

const arg = (name, fallback) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : fallback; };
const EXECUTE = process.argv.includes('--execute');
const REDO = process.argv.includes('--redo');
const WORKERS = Math.max(1, Math.min(8, Number(arg('workers', 4))));
const MEMBERS_FILE = arg('members');
const BACKEND = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(BACKEND, 'src', 'scripts', 'phase2', 'bulk_ledger_replay_parallel.ts');
const clock = () => new Date().toTimeString().slice(0, 8);
if (!MEMBERS_FILE) { console.error('Give the member list: --members=<file with one member number per line>'); process.exit(1); }

(async () => {
  let members = fs.readFileSync(MEMBERS_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pg = new Client(targetConfig());
  await pg.connect();
  if (!REDO) {
    const done = new Set((await pg.query(`SELECT mbno::text m FROM legacy_replay_batch_log WHERE status = 'done'`)).rows.map(r => r.m));
    const before = members.length;
    members = members.filter(m => !done.has(m));
    console.log(`${before - members.length} of ${before} members are already done and are left out.`);
  }
  await pg.end();
  if (!members.length) { console.log('Nothing to do.'); return; }

  const dir = path.join(__dirname, 'reports', 'phase2-parallel');
  fs.mkdirSync(dir, { recursive: true });
  const slices = Array.from({ length: WORKERS }, () => []);
  members.forEach((m, i) => slices[i % WORKERS].push(m)); // round robin: every worker gets a similar mix
  slices.forEach((s, i) => fs.writeFileSync(path.join(dir, `members-${i + 1}.txt`), s.join('\n') + '\n'));
  console.log(`${members.length} members, ${WORKERS} workers (${slices.map(s => s.length).join(' / ')} members each).`);
  if (!EXECUTE) { console.log('Listing only. Add --execute to start the workers.'); return; }

  const started = Date.now();
  let done = 0, failed = 0, skipped = 0, finishedWorkers = 0;
  const total = members.length;
  slices.forEach((s, i) => {
    const w = i + 1;
    const log = fs.createWriteStream(path.join(dir, `worker-${w}.log`));
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', SCRIPT], {
      cwd: BACKEND,
      env: { ...process.env, DRY_RUN: 'false', CONFIRM_LIVE_RUN: 'yes-i-mean-it', MBNO_FILE: path.join(dir, `members-${w}.txt`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    const onData = chunk => {
      const text = chunk.toString();
      log.write(text);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        let m;
        if ((m = /^MEMBER_DONE (\d+) (.*)$/.exec(line))) {
          done++;
          const mins = (Date.now() - started) / 60000;
          const eta = done ? Math.round((total - done - failed - skipped) * (mins / (done + failed))) : 0;
          console.log(`${clock()}  DONE    ${m[1].padEnd(11)} ${m[2]}   [w${w}]  ${done + failed + skipped}/${total}  about ${eta} min left`);
        } else if ((m = /^MEMBER_FAILED (\d+) (.*)$/.exec(line))) {
          failed++;
          console.log(`${clock()}  FAILED  ${m[1].padEnd(11)} ${m[2]}   [w${w}]  ${done + failed + skipped}/${total}`);
        } else if ((m = /^MEMBER_SKIPPED (\d+)/.exec(line))) {
          skipped++;
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', c => log.write(c));
    child.on('exit', code => {
      log.end();
      finishedWorkers++;
      console.log(`${clock()}  worker ${w} finished (exit ${code}); ${finishedWorkers}/${WORKERS} workers done`);
      if (finishedWorkers === WORKERS) console.log(`\nALL WORKERS FINISHED in ${Math.round((Date.now() - started) / 60000)} min. Done ${done}, failed ${failed}, skipped ${skipped} of ${total}. Logs: ${dir}`);
    });
  });
})().catch(e => { console.error(e.message); process.exit(1); });
