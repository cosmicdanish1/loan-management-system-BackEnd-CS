/**
 * Hits API endpoints repeatedly for N minutes to measure how much log data
 * (files + service_log DB rows) that traffic produces, then extrapolates to
 * 1 hour / 1 day so LOG_MAX_SIZE / LOG_RETENTION_DAYS / the service_log purge
 * window can be sized with a real number instead of a guess.
 *
 * Includes write endpoints (POST/PUT/PATCH) by default — confirmed safe to
 * run against this DB because it's a disposable test instance, not the real
 * production ledger. A small BLOCKED_PATTERNS list still excludes operations
 * that are dangerous even on a throwaway DB because they're stateful/one-shot
 * or can lock out the very account running the test: day-end processing,
 * backup/restore, license activation, financial-year closing, password
 * change, logout, and new user registration. DELETE is excluded by default
 * too (separate risk: it can remove rows other calls in the same run depend
 * on) — opt in with LOAD_TEST_INCLUDE_DELETES=true if you want it included.
 *
 * Usage:
 *   1. Copy scripts/load-test/.credentials.json.example to .credentials.json
 *      and fill in a real (or dedicated test) username/password. That file is
 *      gitignored — never commit it.
 *   2. Make sure the backend is running (npm run start:dev or start:prod).
 *   3. node scripts/load-test/measure-log-volume.js
 *
 * Env overrides:
 *   LOAD_TEST_MINUTES=15             how long to run (ignored if LOAD_TEST_TARGET_GB is set)
 *   LOAD_TEST_TARGET_GB=10           run until combined log growth (file + DB) reaches this
 *                                    many GB instead of a fixed time — e.g. to bombard the
 *                                    logs up to 10GB and watch rotation/retention kick in live.
 *   LOAD_TEST_MAX_MINUTES=240        safety cap so a target-GB run can't go forever if
 *                                    something's wrong (default 4h in target mode)
 *   LOAD_TEST_CONCURRENCY=5          concurrent "users" hammering endpoints
 *   LOAD_TEST_BASE_URL=http://localhost:3000/api/v1
 *   LOAD_TEST_INCLUDE_WRITES=false   set to skip POST/PUT/PATCH and go GET-only
 *   LOAD_TEST_INCLUDE_DELETES=true   set to also include DELETE endpoints
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const MINUTES = parseFloat(process.env.LOAD_TEST_MINUTES || '15');
const TARGET_GB = process.env.LOAD_TEST_TARGET_GB ? parseFloat(process.env.LOAD_TEST_TARGET_GB) : null;
const MAX_MINUTES = parseFloat(process.env.LOAD_TEST_MAX_MINUTES || (TARGET_GB ? '240' : String(MINUTES)));
const DURATION_MS = MAX_MINUTES * 60 * 1000;
const SIZE_CHECK_INTERVAL_MS = 30_000;
const CONCURRENCY = parseInt(process.env.LOAD_TEST_CONCURRENCY || '5', 10);
const INCLUDE_WRITES = process.env.LOAD_TEST_INCLUDE_WRITES !== 'false';
const INCLUDE_DELETES = process.env.LOAD_TEST_INCLUDE_DELETES === 'true';

// Dangerous even on a throwaway DB: one-shot/stateful processes, or things
// that lock out the account this script is logged in as.
const BLOCKED_PATTERNS = /day-?end|backup|restore|license|financial-year|change-password|logout|\/auth\/register/i;

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    // split on \r?\n — this .env has Windows CRLF endings; splitting on '\n'
    // alone leaves a trailing \r on every value, which silently breaks the
    // match below and makes every single var come back undefined.
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}
const ENV = loadEnv();

const BASE_URL = process.env.LOAD_TEST_BASE_URL || `http://localhost:${ENV.PORT || 3000}/${ENV.API_PREFIX || 'api/v1'}`;
const LOG_DIR = path.isAbsolute(ENV.LOG_FILE_PATH || '')
  ? ENV.LOG_FILE_PATH
  : path.join(ROOT, (ENV.LOG_FILE_PATH || './logs').replace(/^\.\//, ''));

const credsPath = path.join(__dirname, '.credentials.json');
if (!fs.existsSync(credsPath)) {
  console.error(
    `Missing credentials file: ${credsPath}\n` +
    `Copy .credentials.json.example -> .credentials.json and fill in a valid username/password first.`,
  );
  process.exit(1);
}
const { username, password } = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));

function fmtBytes(n) {
  if (!isFinite(n)) return 'n/a';
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${sign}${n.toFixed(2)} ${units[i]}`;
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* file rotated away mid-read, ignore */
      }
    }
  }
  return total;
}

async function dbLogBytes() {
  const client = new Client({
    host: ENV.DB_HOST || 'localhost',
    port: parseInt(ENV.DB_PORT || '5432', 10),
    user: ENV.DB_USERNAME,
    password: ENV.DB_PASSWORD,
    database: ENV.DB_DATABASE,
  });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(table_name))), 0)::bigint AS bytes
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'service_log%'`,
    );
    return Number(res.rows[0].bytes);
  } finally {
    await client.end();
  }
}

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: HTTP ${res.status} — ${await res.text()}`);
  }
  const json = await res.json();
  const token = json?.data?.accessToken || json?.accessToken;
  if (!token) throw new Error('Login succeeded but no accessToken found in response');
  return token;
}

function authedRequest(method, pathname, token, body) {
  return fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).catch((err) => ({ ok: false, status: 0, _networkError: err.message }));
}

/** Best-effort real sample values so parameterized endpoints (member lookups,
 *  edits, etc.) hit real rows instead of always 404ing — makes the volume
 *  estimate closer to what genuine usage looks like. Falls back to
 *  placeholders if unavailable. Also fed into synthesized write bodies. */
async function collectSampleValues(token) {
  const sample = { memberNo: '1', id: '1', mbno: '1', code: 'GEN', key: 'GENERAL', levelId: '1', type: 'photo' };
  try {
    const res = await authedRequest('GET', '/members?limit=5', token);
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.items) ? json.data.items : [];
      const first = list[0];
      if (first) {
        sample.memberNo = String(first.memberNo ?? first.mbno ?? first.mbNo ?? sample.memberNo);
        sample.mbno = sample.memberNo;
        sample.id = String(first.id ?? sample.id);
      }
    }
  } catch {
    /* best effort — placeholders are fine */
  }
  try {
    const res = await authedRequest('GET', '/auth/users-list', token);
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      if (list[0]?.id) sample.id = String(list[0].id);
    }
  } catch {
    /* best effort */
  }
  return sample;
}

function fillPath(pathname, sample) {
  return pathname.replace(/\{([^}]+)\}/g, (_m, name) => sample[name] ?? '1');
}

function resolveRef(ref, spec) {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((acc, part) => (acc ? acc[part] : undefined), spec);
}

/** Heuristic fill for property names that map to something we already know a
 *  real value for, so synthesized bodies are more likely to pass validation
 *  and reach the service/DB layer instead of dying at 400. */
function smartValueForKey(key, sample) {
  const k = key.toLowerCase();
  if (k === 'username') return sample.username || username;
  if (k.includes('memberno') || k === 'mbno') return sample.memberNo;
  if (k === 'id' || k.endsWith('id')) return sample.id;
  if (k.includes('amount') || k.includes('balance')) return 100;
  if (k.includes('rate')) return 5;
  if (k.includes('email')) return 'loadtest@example.com';
  if (k.includes('phone') || k.includes('mobile')) return '9999999999';
  return undefined;
}

/** Generic OpenAPI-schema -> example-value synthesizer. Prefers a declared
 *  `example`/`default`/`enum` value, falls back to a type-appropriate filler.
 *  Not a full JSON Schema implementation — good enough to get past basic
 *  validation for log-volume purposes, not a correctness test. */
function synthesizeValue(schema, spec, sample, depth, key) {
  if (!schema || depth > 5) return null;
  if (schema.$ref) return synthesizeValue(resolveRef(schema.$ref, spec), spec, sample, depth, key);
  if (key) {
    const smart = smartValueForKey(key, sample);
    if (smart !== undefined) return smart;
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length) return schema.enum[0];

  switch (schema.type) {
    case 'object': {
      const obj = {};
      for (const k of Object.keys(schema.properties || {})) {
        obj[k] = synthesizeValue(schema.properties[k], spec, sample, depth + 1, k);
      }
      return obj;
    }
    case 'array': {
      const item = synthesizeValue(schema.items, spec, sample, depth + 1, key);
      return item === null || item === undefined ? [] : [item];
    }
    case 'string':
      if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
      if (schema.format === 'date-time') return new Date().toISOString();
      return 'load-test';
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

function buildRequestBody(op, spec, sample) {
  const schema = op.requestBody?.content?.['application/json']?.schema;
  if (!schema) return undefined;
  return synthesizeValue(schema, spec, sample, 0, undefined);
}

async function main() {
  const spec = require(path.join(ROOT, 'docs', 'api', 'openapi.json'));

  const allPathsFlat = [];
  for (const p of Object.keys(spec.paths)) {
    for (const method of Object.keys(spec.paths[p])) {
      allPathsFlat.push({ path: p, method: method.toLowerCase(), op: spec.paths[p][method] });
    }
  }
  const getCount = allPathsFlat.filter((o) => o.method === 'get').length;
  const writeCount = allPathsFlat.length - getCount;

  console.log(`API surface: ${getCount} GET, ${writeCount} write endpoints.`);
  console.log(`Mode: ${INCLUDE_WRITES ? 'GET + writes' : 'GET-only'}${INCLUDE_WRITES ? (INCLUDE_DELETES ? ' (incl. DELETE)' : ' (excl. DELETE)') : ''}`);
  console.log('Logging in...');
  const token = await login();
  console.log('Logged in. Collecting sample IDs for parameterized endpoints...');
  const sample = await collectSampleValues(token);

  let ops = allPathsFlat.filter((o) => {
    if (o.method === 'get') return true;
    if (!INCLUDE_WRITES) return false;
    if (BLOCKED_PATTERNS.test(o.path)) return false;
    if (o.method === 'delete' && !INCLUDE_DELETES) return false;
    return ['post', 'put', 'patch', 'delete'].includes(o.method);
  });

  const blockedCount = allPathsFlat.length - getCount - ops.filter((o) => o.method !== 'get').length;
  if (INCLUDE_WRITES) {
    console.log(`Excluded ${blockedCount} write endpoints (blocklist and/or DELETE opt-out).`);
  }

  const requests = ops.map((o) => ({
    method: o.method.toUpperCase(),
    path: fillPath(o.path, sample),
    body: o.method === 'get' ? undefined : buildRequestBody(o.op, spec, sample),
  }));

  console.log(`Prepared ${requests.length} requests to cycle through.`);
  console.log(`Measuring baseline sizes...`);

  const beforeFileBytes = dirSize(LOG_DIR);
  const beforeDbBytes = await dbLogBytes();
  console.log(`  logs/ dir:        ${fmtBytes(beforeFileBytes)}`);
  console.log(`  service_log (DB): ${fmtBytes(beforeDbBytes)}`);

  if (TARGET_GB) {
    console.log(`\nTarget mode: running until combined log growth reaches ${TARGET_GB}GB (safety cap: ${MAX_MINUTES} min), ${CONCURRENCY} concurrent workers, no delay between requests...\n`);
  } else {
    console.log(`\nRunning for ${MINUTES} minute(s) with ${CONCURRENCY} concurrent workers, no delay between requests (max-throughput / worst-case scenario)...\n`);
  }

  const stats = { total: 0, ok: 0, errors: 0, byStatus: {}, byMethod: {} };
  let endAt = Date.now() + DURATION_MS;
  const startAt = Date.now();

  async function worker(offset) {
    let i = offset;
    while (Date.now() < endAt) {
      const req = requests[i % requests.length];
      i += CONCURRENCY;
      const res = await authedRequest(req.method, req.path, token, req.body);
      stats.total++;
      const status = res.status || 0;
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
      stats.byMethod[req.method] = (stats.byMethod[req.method] || 0) + 1;
      if (res.ok) stats.ok++;
      else stats.errors++;
    }
  }

  const progressTimer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startAt) / 1000);
    process.stdout.write(`\r  ${elapsedSec}s elapsed — ${stats.total} requests sent (${stats.ok} ok, ${stats.errors} non-2xx)   `);
  }, 5000);

  let sizeCheckTimer;
  if (TARGET_GB) {
    const targetBytes = TARGET_GB * 1024 ** 3;
    sizeCheckTimer = setInterval(async () => {
      try {
        const currentFileBytes = dirSize(LOG_DIR);
        const currentDbBytes = await dbLogBytes();
        const grown = (currentFileBytes - beforeFileBytes) + (currentDbBytes - beforeDbBytes);
        process.stdout.write(`\n  [size check] growth so far: ${fmtBytes(grown)} / ${fmtBytes(targetBytes)} target\n`);
        if (grown >= targetBytes) {
          console.log(`\n  Target reached — stopping workers.`);
          endAt = Date.now();
        }
      } catch (err) {
        console.error(`\n  Size check failed (continuing): ${err.message}`);
      }
    }, SIZE_CHECK_INTERVAL_MS);
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  clearInterval(progressTimer);
  if (sizeCheckTimer) clearInterval(sizeCheckTimer);

  console.log(`\n\nRun complete. Waiting 3s for in-flight log writes to flush...`);
  await new Promise((r) => setTimeout(r, 3000));

  const afterFileBytes = dirSize(LOG_DIR);
  const afterDbBytes = await dbLogBytes();

  const fileDelta = afterFileBytes - beforeFileBytes;
  const dbDelta = afterDbBytes - beforeDbBytes;
  const totalDelta = fileDelta + dbDelta;
  const actualMinutes = (Date.now() - startAt) / 60000;
  const reqPerSec = stats.total / (actualMinutes * 60);

  console.log(`\n=== RESULTS (${actualMinutes.toFixed(1)} min, ${CONCURRENCY} concurrent workers, ${TARGET_GB ? `target-GB mode: ${TARGET_GB}GB` : `fixed-time mode`}) ===`);
  console.log(`Requests sent:        ${stats.total}  (${stats.ok} ok / ${stats.errors} non-2xx)`);
  console.log(`By method:            ${JSON.stringify(stats.byMethod)}`);
  console.log(`Status breakdown:     ${JSON.stringify(stats.byStatus)}`);
  console.log(`Throughput:           ${reqPerSec.toFixed(1)} req/sec`);
  console.log(``);
  console.log(`File log growth:      ${fmtBytes(fileDelta)}`);
  console.log(`service_log DB growth:${fmtBytes(dbDelta)}`);
  console.log(`Total growth:         ${fmtBytes(totalDelta)}`);
  console.log(`Per request:          ${fmtBytes(totalDelta / (stats.total || 1))}`);
  console.log(``);
  console.log(`--- Extrapolated at THIS rate (worst case — no idle time) ---`);
  console.log(`  1 hour: ${fmtBytes((totalDelta / actualMinutes) * 60)}   (file: ${fmtBytes((fileDelta / actualMinutes) * 60)}, db: ${fmtBytes((dbDelta / actualMinutes) * 60)})`);
  console.log(`  1 day:  ${fmtBytes((totalDelta / actualMinutes) * 60 * 24)}   (file: ${fmtBytes((fileDelta / actualMinutes) * 60 * 24)}, db: ${fmtBytes((dbDelta / actualMinutes) * 60 * 24)})`);
  console.log(``);
  console.log(`Note: this is a max-throughput burst test (no think-time between requests) — treat`);
  console.log(`the 1-day figure as a ceiling for disk sizing, not what you'll see in normal daily use.`);
  if (stats.byStatus['401']) {
    console.log(`\nHeads up: ${stats.byStatus['401']} requests got 401 — the JWT likely expired mid-run. Re-run with a shorter`);
    console.log(`LOAD_TEST_MINUTES or check the access token TTL if this number is large relative to total requests.`);
  }
}

main().catch((err) => {
  console.error('\nLoad test failed:', err.message);
  process.exit(1);
});
