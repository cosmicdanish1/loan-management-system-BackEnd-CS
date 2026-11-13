'use strict';
// Step 14 hook: (a) equality check of the LOADED ledger and loan_master against legacy, (b) the existing
// Phase 2 replay (src/scripts/phase2/bulk_ledger_replay.ts, UNCHANGED) started through the existing
// run-phase2.js wrapper. The replay reads the legacy database itself and has its target hard-coded
// (localhost:5432, EMP_Espat_Society, user postgres, password from DB_PASSWORD), so this module refuses to start it
// against anything else instead of working around that.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const canon = require('./canon');
const { mapColumns } = require('./colmap');
const { legacyBatches, legacySums } = require('./engine');
const { byId } = require('./spec');
const { pgq } = require('./target');

const PHASE2_FIXED = { host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', legacyDb: 'EMP_Espat_Society_dan' };

function phase2Preconditions(ctx) {
  const c = ctx.target.config, problems = [];
  if (!['localhost', '127.0.0.1', '::1'].includes(String(c.host))) problems.push(`target host is ${c.host}; the replay script is hard-wired to localhost`);
  if (Number(c.port) !== PHASE2_FIXED.port) problems.push(`target port is ${c.port}; the replay script is hard-wired to ${PHASE2_FIXED.port}`);
  if (c.database !== PHASE2_FIXED.database) problems.push(`target database is ${c.database}; the replay script is hard-wired to ${PHASE2_FIXED.database}`);
  if (c.user !== PHASE2_FIXED.user) problems.push(`target user is ${c.user}; the replay script is hard-wired to ${PHASE2_FIXED.user}`);
  if (ctx.legacy.database !== PHASE2_FIXED.legacyDb) problems.push(`legacy database is ${ctx.legacy.database}; the replay script is hard-wired to ${PHASE2_FIXED.legacyDb}`);
  return problems;
}

/** Fingerprint of legacy vs loaded rows with the target column kinds (before Phase 2 touches loan_master). */
async function equalityCheck(ctx, tableId) {
  const s = byId[tableId];
  const map = mapColumns(ctx.legacy.columns(s.legacy), await ctx.target.columns(s.id));
  if (map.missingInTarget.length) return { table: tableId, ok: false, detail: `schema drift: ${map.missingInTarget.join(', ')}` };
  const cols = map.shared.map(c => ({ name: c.name, kind: c.kind }));
  const a = new canon.MultisetFingerprint(), b = new canon.MultisetFingerprint();
  const ao = new canon.OrderedHash(), bo = new canon.OrderedHash();
  for (const batch of legacyBatches(ctx.legacy, s, map.shared)) for (const r of batch) { const c = canon.canonRow(r, cols); a.add(c); if (s.orderedHash) ao.add(c); }
  const order = s.order.startsWith('key:') ? ` ORDER BY ${pgq(s.order.split(':')[1].toLowerCase())}` : '';
  for await (const rows of ctx.target.cursor(`SELECT ${cols.map(c => pgq(c.name)).join(',')} FROM ${pgq(s.id)}${order}`)) for (const r of rows) { const c = canon.canonRow(r, cols); b.add(c); if (s.orderedHash) bo.add(c); }
  const sums = legacySums(ctx.legacy, s);
  const ok = a.count === b.count && a.hex() === b.hex() && (!s.orderedHash || ao.hex() === bo.hex()) && a.count === sums.rows;
  return { table: tableId, ok, detail: `legacy ${a.count} rows, loaded ${b.count} rows, SHA-256 ${a.hex() === b.hex() ? 'equal' : 'DIFFERENT'}${s.orderedHash ? ', ordered ' + (ao.hex() === bo.hex() ? 'equal' : 'DIFFERENT') : ''}` };
}

/**
 * mode: 'check' (equality only) | 'dry' (replay dry run: DRY_RUN default, writes nothing) | 'run' (real replay).
 * Returns the list of checks; the real replay is only started with --execute AND --confirm-phase2.
 */
async function runPhase2(ctx, mode, { memberFile } = {}) {
  const checks = [];
  const started = (await ctx.target.tableExists('legacy_replay_batch_log')) && (await ctx.target.hasRows('legacy_replay_batch_log'));
  // loan_master is modified by Phase 2: once a replay has started only the ledger can still be compared
  for (const id of started ? ['ledger'] : ['ledger', 'loan_master']) checks.push(await equalityCheck(ctx, id));
  const equal = checks.every(c => c.ok);
  if (mode === 'check' || !equal) return { checks, equal, ran: false };
  const problems = phase2Preconditions(ctx);
  if (problems.length) return { checks, equal, ran: false, refused: problems };
  const backend = path.resolve(__dirname, '../../../..');
  const wrapper = path.join(backend, 'scripts', 'legacy-migration', 'run-phase2.js');
  if (!fs.existsSync(wrapper)) return { checks, equal, ran: false, refused: [`run-phase2.js not found at ${wrapper}`] };
  if (memberFile && !fs.existsSync(memberFile)) return { checks, equal, ran: false, refused: [`pinned member list not found: ${memberFile}`] };
  const env = { ...process.env, DB_PASSWORD: ctx.target.config.password || '' };
  if (memberFile) env.MBNO_FILE = memberFile;
  if (mode === 'run') { env.DRY_RUN = 'false'; env.CONFIRM_LIVE_RUN = 'yes-i-mean-it'; } else { delete env.DRY_RUN; delete env.CONFIRM_LIVE_RUN; }
  const r = spawnSync(process.execPath, [wrapper], { cwd: backend, env, stdio: 'inherit' });
  return { checks, equal, ran: true, exitCode: r.status };
}

module.exports = { PHASE2_FIXED, phase2Preconditions, equalityCheck, runPhase2 };
