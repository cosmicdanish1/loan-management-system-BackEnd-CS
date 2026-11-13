#!/usr/bin/env node
'use strict';
/**
 * Legacy MS SQL -> fresh production Postgres: the migration runner of migration-v1.md section 44 (THE RUN SHEET).
 *
 *   DRY RUN IS THE DEFAULT. Without --execute this program writes to no Postgres database and to the legacy
 *   database never (every legacy statement must pass lib/sqlguard.js). See README.md.
 *
 *   node run-migration.js                          prints the plan and the checks it WOULD run (no database touched)
 *   node run-migration.js --check-legacy           + runs the read-only legacy pre-flight
 *   node run-migration.js --check-legacy --report-lines   + the "report only" lines of every table section (about 3 min)
 *   node run-migration.js --check-target --target-db=NAME   + read-only target pre-flight (empty guard, drift, template)
 *   node run-migration.js --baseline               legacy baseline (counts, sums, SHA-256 of every table) -> JSON
 *   node run-migration.js --execute ...            the load, steps 1-13 in ONE transaction (see README)
 *   node run-migration.js --phase2=check|dry|run   step 14 hook;  --verify-only  step 15 suite on a loaded target
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Legacy } = require('./lib/legacy');
const { Target, loadConfig } = require('./lib/target');
const { ReviewReport } = require('./lib/report');
const spec = require('./lib/spec');
const { plannedChecks, legacyPreflight, inputChecks, targetPreflight } = require('./lib/preflight');
const { runLoadStep } = require('./lib/steps');
const { planCopy, legacyBaseline } = require('./lib/engine');
const verify = require('./lib/verify');
const phase2 = require('./lib/phase2');

function parseArgs(argv) {
  const o = { flags: new Set(), values: {} };
  for (const a of argv) {
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const [k, ...rest] = a.slice(2).split('=');
    if (rest.length) o.values[k] = rest.join('='); else o.flags.add(k);
  }
  return o;
}

function buildOptions(args) {
  const v = args.values, f = args.flags;
  const known = new Set(['execute', 'check-legacy', 'check-target', 'report-lines', 'baseline', 'verify-only', 'deep-hash', 'help', 'confirm-phase2']);
  const knownV = new Set(['target-db', 'confirm-target', 'legacy-db', 'legacy-server', 'go-live-date', 'society-values', 'baseline-file', 'steps', 'out-dir', 'gl-tolerance', 'backup-file', 'expect-dump-date', 'migrations-dir', 'phase2', 'member-file']);
  for (const x of f) if (!known.has(x)) throw new Error(`Unknown flag --${x} (use --help)`);
  for (const x of Object.keys(v)) if (!knownV.has(x)) throw new Error(`Unknown option --${x} (use --help)`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    execute: f.has('execute'), checkLegacy: f.has('check-legacy'), checkTarget: f.has('check-target'), reportLines: f.has('report-lines'),
    baseline: f.has('baseline'), verifyOnly: f.has('verify-only'), deepHash: f.has('deep-hash'), help: f.has('help'), confirmPhase2: f.has('confirm-phase2'),
    targetDb: v['target-db'], confirmTarget: v['confirm-target'], legacyDb: v['legacy-db'], legacyServer: v['legacy-server'],
    goLiveDate: v['go-live-date'], societyValuesFile: v['society-values'] && path.resolve(v['society-values']), baselineFile: v['baseline-file'] && path.resolve(v['baseline-file']),
    steps: v.steps ? v.steps.split(',').map(Number) : null, outDir: path.resolve(v['out-dir'] || path.join(__dirname, '..', 'reports', `run-${stamp}`)),
    glTolerance: v['gl-tolerance'] || '500000', backupFile: v['backup-file'] && path.resolve(v['backup-file']), expectDumpDate: v['expect-dump-date'],
    migrationsDir: v['migrations-dir'] && path.resolve(v['migrations-dir']), phase2: v.phase2, memberFile: v['member-file'] && path.resolve(v['member-file']),
  };
}

const HELP = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 17).map(l => l.replace(/^ \*\s?/, '')).join('\n');

// ------------------------------------------------------------------ printing
const line = (s = '') => console.log(s);
function printChecks(title, checks) {
  line(title);
  for (const c of checks) line(`  [${c.ok ? 'PASS' : (c.blocking ? 'FAIL' : 'NOTE')}] ${c.name}  (${c.section})  ${c.detail}`);
}

function printPlan(opts) {
  const steps = spec.STEPS.filter(s => !opts.steps || opts.steps.includes(s.no));
  line('=== THE PLAN (migration-v1.md section 44) ===');
  line('Pre-flight, no writes:');
  for (const [where, sec, text] of plannedChecks(opts)) line(`  - [${where}] ${text}  (${sec})`);
  line('');
  line('Load, in one Postgres transaction (any failed check rolls back everything; the target stays empty):');
  for (const s of steps) {
    line(`  Step ${String(s.no).padStart(2)}  ${s.title}`);
    line(`           sections ${s.sections}; stops the run: ${s.stops}`);
    for (const id of s.tables) if (spec.byId[id] && s.kind.startsWith('copy')) line(`           - ${planCopy(spec.byId[id])}`);
  }
  line('');
  line('Step 14 runs as its own command after the commit (--phase2=check|dry|run). Step 15 (verification suite + review report) runs after the commit and can be repeated with --verify-only.');
}

// ------------------------------------------------------------------ helpers
function makeCtx(opts) {
  const legacy = new Legacy({ ...(opts.legacyServer ? { server: opts.legacyServer } : {}), ...(opts.legacyDb ? { database: opts.legacyDb } : {}) });
  const report = new ReviewReport({ legacyDatabase: legacy.database, target: opts.targetDb || '(none: dry run)', mode: opts.execute ? 'EXECUTE' : 'dry-run / read-only', startedAt: new Date().toISOString() });
  let baseline = null;
  if (opts.baselineFile) {
    const j = JSON.parse(fs.readFileSync(opts.baselineFile, 'utf8'));
    baseline = new Map(j.tables.map(t => [t.table, t]));
  }
  return { legacy, target: null, execute: false, report, opts, baseline, state: {}, log: s => line(s) };
}

function writeReport(ctx, name) {
  fs.mkdirSync(ctx.opts.outDir, { recursive: true });
  ctx.report.meta.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ctx.opts.outDir, `${name}.json`), JSON.stringify(ctx.report.toJSON(), null, 2));
  fs.writeFileSync(path.join(ctx.opts.outDir, `${name}.md`), ctx.report.toMarkdown());
  fs.writeFileSync(path.join(ctx.opts.outDir, `${name}.csv`), ctx.report.toCsv());
  line(`Report written to ${ctx.opts.outDir} (${name}.md / .json / .csv)`);
}

function backupTarget(ctx) {
  const o = ctx.opts;
  if (o.backupFile) {
    if (!fs.existsSync(o.backupFile) || fs.statSync(o.backupFile).size < 1024) throw new Error(`--backup-file ${o.backupFile} is missing or empty`);
    return { path: o.backupFile, bytes: fs.statSync(o.backupFile).size, provided: true };
  }
  const c = ctx.target.config;
  const exe = process.env.PG_DUMP_PATH || 'pg_dump';
  const dest = path.join(o.outDir, `pre-load-${c.database}.dump`);
  fs.mkdirSync(o.outDir, { recursive: true });
  const r = spawnSync(exe, ['-Fc', '--no-owner', '--no-acl', '-h', c.host, '-p', String(c.port), '-U', c.user, '-d', c.database, '-f', dest], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: c.password || '' } });
  if (r.status !== 0) throw new Error('pg_dump failed: ' + (r.stderr || r.stdout || '').split('\n')[0]);
  const bytes = fs.statSync(dest).size;
  if (bytes < 1024) throw new Error('pg_dump file is unexpectedly small');
  return { path: dest, bytes, provided: false };
}

// ------------------------------------------------------------------ modes
async function modeBaseline(ctx) {
  line('=== BASELINE (read-only): row count, sums and SHA-256 of every table in scope ===');
  const tables = [];
  for (const s of spec.COPY_TABLES) {
    const t0 = Date.now();
    const b = legacyBaseline(ctx.legacy, s);
    tables.push(b);
    line(`  ${s.id.padEnd(28)} ${String(b.rows).padStart(9)} rows  ${Object.entries(b.sums).map(([k, v]) => `${k}=${v}`).join(' ')}  sha256 ${b.sha256.slice(0, 16)}...  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const dumpDate = ctx.legacy.scalar('SELECT CONVERT(varchar(10),MAX(TRANS_DATE),126) AS d FROM ledger');
  const out = { generatedAt: new Date().toISOString(), legacyDatabase: ctx.legacy.database, dumpDate, tables };
  fs.mkdirSync(ctx.opts.outDir, { recursive: true });
  const file = ctx.opts.baselineFile || path.join(ctx.opts.outDir, 'baseline.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  line(`Baseline (dump date ${dumpDate}) written to ${file}. Pass it with --baseline-file= to the load.`);
  return 0;
}

async function openTarget(ctx, { writable }) {
  if (!ctx.opts.targetDb) throw new Error('--target-db=<name> is required for this mode (there is no default target, on purpose)');
  ctx.target = new Target(loadConfig({ database: ctx.opts.targetDb }), { writable });
  await ctx.target.connect();
  return ctx.target;
}

async function modeCheck(ctx) {
  const o = ctx.opts;
  let blocked = false;
  if (o.checkLegacy || o.reportLines) {
    const checks = legacyPreflight(ctx);
    checks.forEach(c => ctx.report.check(c));
    printChecks('Legacy pre-flight (read-only):', checks);
    blocked = checks.some(c => !c.ok && c.blocking);
    if (o.reportLines) {
      line('Report lines (read-only queries on legacy, reference = dump of 03-Nov-2026):');
      const lines = verify.legacyReportLines(ctx);
      for (const l of lines) line(`  ${l.count === l.expected ? '=' : '~'} ${l.id.padEnd(36)} ${String(l.count).padStart(8)}   (dump ${l.expected})`);
    }
  } else {
    const inp = inputChecks(ctx); inp.forEach(c => ctx.report.check(c));
    printChecks('Input checks (no database touched):', inp);
    blocked = inp.some(c => !c.ok && c.blocking);
  }
  if (o.checkTarget) {
    await openTarget(ctx, { writable: false });
    try {
      const checks = await targetPreflight(ctx);
      checks.forEach(c => ctx.report.check(c));
      printChecks(`Target pre-flight (READ-ONLY session on ${o.targetDb}):`, checks);
      blocked = blocked || checks.some(c => !c.ok && c.blocking);
    } finally { await ctx.target.end(); }
  }
  line('');
  line(blocked ? 'RESULT: BLOCKED. At least one blocker is open (see FAIL lines). Nothing was written anywhere.' : 'RESULT: no blocker found by the checks that ran. Nothing was written anywhere.');
  if (o.checkLegacy || o.reportLines || o.checkTarget) writeReport(ctx, 'preflight');
  return blocked ? 2 : 0;
}

async function modeExecute(ctx) {
  const o = ctx.opts;
  if (!o.targetDb || o.confirmTarget !== o.targetDb) throw new Error('--execute needs --target-db=NAME and --confirm-target=NAME (the same name, typed twice)');
  if (o.steps) throw new Error('--steps is for dry runs only: a real load always runs steps 1 to 13 in one transaction');
  line(`=== EXECUTE: load into ${o.targetDb} (steps 1-13, one transaction) ===`);
  const pre = legacyPreflight({ ...ctx, execute: true });
  pre.forEach(c => ctx.report.check(c));
  printChecks('Legacy pre-flight:', pre);
  if (pre.some(c => !c.ok && c.blocking)) { writeReport(ctx, 'blocked'); line('BLOCKED before any write.'); return 2; }

  await openTarget(ctx, { writable: true });
  ctx.execute = true;
  try {
    const tpre = await targetPreflight(ctx);
    tpre.forEach(c => ctx.report.check(c));
    printChecks('Target pre-flight:', tpre);
    if (tpre.some(c => !c.ok && c.blocking)) { writeReport(ctx, 'blocked'); line('BLOCKED before any write (the target is untouched).'); return 2; }
    const backup = backupTarget(ctx);
    line(`Backup of the template before any write: ${backup.path} (${backup.bytes} bytes${backup.provided ? ', provided' : ''})`);
    ctx.report.meta.backup = backup.path;

    await ctx.target.begin();
    await ctx.target.write("SELECT pg_advisory_xact_lock(hashtext('legacy-migration-runner'))");
    try {
      for (const step of spec.STEPS.filter(s => s.no <= 13)) {
        const t0 = Date.now();
        line(`Step ${step.no}: ${step.title}  [${step.sections}]`);
        const r = await runLoadStep(ctx, step);
        line(`  -> ok, ${r.rows} rows, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
      const failedChecks = ctx.report.failedBlockingChecks;
      if (failedChecks.length) throw new Error(`${failedChecks.length} blocking check(s) failed: ${failedChecks.map(c => c.name).join('; ')}`);
      await ctx.target.commit();
      line('COMMITTED. Steps 1 to 13 are in the target database.');
    } catch (e) {
      await ctx.target.rollback();
      ctx.report.step({ no: '-', title: 'ROLLED BACK', status: 'FAILED: ' + e.message });
      line(`FAILED: ${e.message}`);
      line('ROLLED BACK: the target is still empty. Fix the cause and run again.');
      writeReport(ctx, 'failed');
      return 1;
    }
    // step 15 (read-only, after the commit)
    await finish(ctx);
    return ctx.report.failedBlockingChecks.length ? 1 : 0;
  } finally { await ctx.target.end(); }
}

async function finish(ctx) {
  line('Step 15: verification suite and review report');
  await verify.verifyTables(ctx, { deep: ctx.opts.deepHash });
  await verify.verifyLedger(ctx);
  await verify.verifyLoans(ctx);
  verify.legacyReportLines(ctx);
  verify.manualSmokeTest(ctx);
  printChecks('Verification suite:', ctx.report.checks);
  writeReport(ctx, 'review-report');
  line(ctx.report.failedBlockingChecks.length ? `NOT READY: ${ctx.report.failedBlockingChecks.length} blocking check(s) failed.` : 'Verification suite passed. Next: --phase2=check, then --phase2=dry, then --phase2=run --execute --confirm-phase2 (step 14); re-run --verify-only afterwards.');
}

async function modeVerifyOnly(ctx) {
  await openTarget(ctx, { writable: false });
  try { await finish(ctx); } finally { await ctx.target.end(); }
  return ctx.report.failedBlockingChecks.length ? 1 : 0;
}

async function modePhase2(ctx) {
  const o = ctx.opts;
  const mode = o.phase2;
  if (!['check', 'dry', 'run'].includes(mode)) throw new Error('--phase2 must be check, dry or run');
  if (mode === 'run' && !(o.execute && o.confirmPhase2)) throw new Error('--phase2=run needs --execute --confirm-phase2');
  if (mode === 'run' && !o.memberFile) throw new Error('--phase2=run needs --member-file=<pinned reviewed member list> (Q54)');
  await openTarget(ctx, { writable: false });
  try {
    line(`=== STEP 14 hook, mode ${mode} (the replay script itself is unchanged) ===`);
    const r = await phase2.runPhase2(ctx, mode, { memberFile: o.memberFile });
    for (const c of r.checks) line(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.table}: loaded copy equals legacy before the replay: ${c.detail}`);
    if (!r.equal) { line('BLOCKED: the loaded data differs from legacy; the replay was not started.'); return 2; }
    if (r.refused) { line('REFUSED to start the replay:'); r.refused.forEach(x => line('  - ' + x)); return 2; }
    if (mode === 'check') { line('Equality check passed. Phase 2 not started (mode check).'); return 0; }
    line(`Replay finished with exit code ${r.exitCode}. Now run --verify-only to check failed / LEDGER_MISMATCH_AFTER_REPLAY / LEDGER_OWES_NO_OPEN_CASE and the loan balances.`);
    return r.exitCode === 0 ? 0 : 1;
  } finally { await ctx.target.end(); }
}

// ------------------------------------------------------------------ main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = buildOptions(args);
  if (opts.help) { line(HELP); return 0; }
  const ctx = makeCtx(opts);
  line(opts.execute || opts.phase2 === 'run'
    ? 'MODE: EXECUTE (writes to the target Postgres database named on the command line)'
    : 'MODE: DRY RUN (default). Nothing is written to any Postgres database; the legacy database is only ever read.');
  line(`Legacy source: ${ctx.legacy.database} on ${ctx.legacy.server.replace(String.fromCharCode(92), '\\')}`);
  if (opts.baseline) return modeBaseline(ctx);
  if (opts.phase2) return modePhase2(ctx);
  if (opts.verifyOnly) return modeVerifyOnly(ctx);
  if (opts.execute) return modeExecute(ctx);
  printPlan(opts);
  line('');
  return modeCheck(ctx);
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
module.exports = { parseArgs, buildOptions, main };
