'use strict';
// Applies an uploaded backend release zip to this server, with a database backup first and an
// automatic rollback of the program files if the new version does not come up healthy.
//
//   node apply-update.js <job.json>
//
// job.json: { zip, install, service, port, requestedBy, testMode? }
//
// This script is started by the backend (via a one-off Windows scheduled task, so it is NOT a
// child of the service and survives the service being stopped). It uses nothing but Node's
// standard library, because it replaces the very node_modules the backend runs from.
//
// Order of operations (nothing is changed until step 5):
//   1 unpack zip to a staging folder          2 validate manifest / version / node version
//   3 refuse if day-end is running            4 pg_dump the database
//   5 stop service -> move current files to _rollback -> move new files in
//   6 run SQL migrations                      7 start service, wait for /health to report the new version
//   any failure in 5-7 -> put the old files back, start the old version, report "rolled-back"
//
// Never touched: .env, logs, uploads, backups, tools, server-config files.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const { parseEnv } = require('./env-file');

const SWAP_ITEMS = ['dist', 'node_modules', 'package.json', 'package-lock.json', 'migrations', 'scripts'];
const KEEP_ROLLBACKS = 2;
const KEEP_DUMPS = 5;
const HEALTH_TIMEOUT_MS = 120 * 1000;
const TASK_NAME = 'FibeUpdateRun';
// Windows' own bsdtar reads .zip; a GNU tar earlier on PATH (e.g. from Git) does not.
const WIN_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const TAR = fs.existsSync(WIN_TAR) ? WIN_TAR : 'tar';

const jobFile = process.argv[2];
if (!jobFile) { console.error('usage: node apply-update.js <job.json>'); process.exit(2); }
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const install = path.resolve(job.install);
const port = job.port || 3001;
const service = job.service || 'FibeBackend';
const testMode = !!job.testMode;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = path.join(install, 'logs');
const updateDir = path.join(install, '_update');
const stagingDir = path.join(updateDir, 'staging');
const rollbackDir = path.join(install, '_rollback', stamp);
const statusFile = path.join(install, 'update-status.json');
const logFile = path.join(logDir, `update-${stamp}.log`);
fs.mkdirSync(logDir, { recursive: true });

const status = { state: 'running', step: 'starting', startedAt: new Date().toISOString(), requestedBy: job.requestedBy ?? null, log: logFile };

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* logging must never stop an update */ }
}
function setStatus(patch) {
    Object.assign(status, patch);
    try { fs.writeFileSync(statusFile, JSON.stringify(status, null, 2)); } catch { /* ignore */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
    const r = cp.spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
}

function readVersion(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; }
}
function cmpVersions(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}

function getHealth() {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/health', timeout: 4000 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}
async function waitForVersion(version, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const h = await getHealth();
        if (h && h.status === 'ok' && h.version === version) return true;
        await sleep(2000);
    }
    return false;
}

// ---- service control (test mode swaps in a plain node process so the flow can be exercised
// without installing a real Windows service) ----
const pidFile = path.join(updateDir, 'test-backend.pid');
function stopService() {
    if (testMode) {
        if (fs.existsSync(pidFile)) {
            run('taskkill', ['/PID', fs.readFileSync(pidFile, 'utf8').trim(), '/T', '/F']);
            fs.rmSync(pidFile, { force: true });
        }
        return;
    }
    const r = run('net', ['stop', service]);
    // "service is not started" (code 2) is fine; the goal is only that it is not running.
    log(`net stop ${service}: ${r.out.split('\n').pop()}`);
}
function startService() {
    if (testMode) {
        const child = cp.spawn(process.execPath, [path.join(install, 'dist', 'main.js')], {
            cwd: install, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PORT: String(port) },
        });
        child.unref();
        fs.writeFileSync(pidFile, String(child.pid));
        return;
    }
    const r = run('net', ['start', service]);
    log(`net start ${service}: ${r.out.split('\n').pop()}`);
}

async function moveWithRetry(from, to) {
    for (let i = 0; i < 8; i++) {
        try { fs.renameSync(from, to); return; } catch (e) {
            if (i === 7) throw e;
            await sleep(1500); // antivirus / indexer briefly holding files
        }
    }
}

function backupDatabase(manifest) {
    const env = { ...parseEnv(fs.existsSync(path.join(install, '.env')) ? fs.readFileSync(path.join(install, '.env'), 'utf8') : ''), ...process.env };
    const dumpDir = path.join(install, 'backups');
    fs.mkdirSync(dumpDir, { recursive: true });
    const file = path.join(dumpDir, `pre-update-${readVersion(install)}-to-${manifest.version}-${stamp}.dump`);
    const pgDump = env.PG_DUMP_PATH || 'pg_dump';
    const r = run(pgDump, ['-h', env.DB_HOST || 'localhost', '-p', String(env.DB_PORT || 5432), '-U', env.DB_USERNAME, '-Fc', '-f', file, env.DB_DATABASE], {
        env: { ...process.env, PGPASSWORD: env.DB_PASSWORD || '' },
    });
    if (r.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) {
        throw new Error(`Database backup failed (nothing was changed): ${r.out || r.error?.message || 'pg_dump not found'}`);
    }
    const old = fs.readdirSync(dumpDir).filter((f) => f.startsWith('pre-update-')).sort().reverse().slice(KEEP_DUMPS);
    for (const f of old) fs.rmSync(path.join(dumpDir, f), { force: true });
    return file;
}

async function restorePreviousVersion(moved) {
    log('Rolling back program files...');
    try { stopService(); } catch { /* may already be down */ }
    await sleep(2000);
    for (const item of moved) {
        const live = path.join(install, item);
        fs.rmSync(live, { recursive: true, force: true });
        const saved = path.join(rollbackDir, item);
        if (fs.existsSync(saved)) await moveWithRetry(saved, live);
    }
    startService();
}

function pruneRollbacks() {
    const root = path.join(install, '_rollback');
    if (!fs.existsSync(root)) return;
    for (const d of fs.readdirSync(root).sort().reverse().slice(KEEP_ROLLBACKS)) {
        fs.rmSync(path.join(root, d), { recursive: true, force: true });
    }
}

(async () => {
    const fromVersion = readVersion(install);
    let moved = [];
    let swapped = false;
    try {
        fs.mkdirSync(updateDir, { recursive: true });
        setStatus({ from: fromVersion });
        log(`Update started. Installed version ${fromVersion}, zip ${job.zip}, requested by ${job.requestedBy ?? 'unknown'}`);

        // 1. unpack
        setStatus({ step: 'unpacking' });
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.mkdirSync(stagingDir, { recursive: true });
        const x = run(TAR, ['-xf', job.zip, '-C', stagingDir]);
        if (x.code !== 0) throw new Error(`Could not unpack the zip: ${x.out}`);

        // 2. validate
        setStatus({ step: 'checking' });
        const manifestPath = path.join(stagingDir, 'release-manifest.json');
        if (!fs.existsSync(manifestPath)) throw new Error('release-manifest.json is missing: this is not a Fibe backend release.');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        setStatus({ to: manifest.version });
        for (const must of ['dist/main.js', 'node_modules', 'package.json']) {
            if (!fs.existsSync(path.join(stagingDir, must))) throw new Error(`Release is incomplete: ${must} is missing.`);
        }
        if (readVersion(stagingDir) !== manifest.version) throw new Error('package.json version does not match the manifest.');
        if (fromVersion && cmpVersions(manifest.version, fromVersion) <= 0) {
            throw new Error(`Release ${manifest.version} is not newer than the installed ${fromVersion}.`);
        }
        const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
        if (manifest.nodeMajor && manifest.nodeMajor !== nodeMajor) {
            throw new Error(`This release was built for Node ${manifest.nodeMajor} but this server runs Node ${nodeMajor}.`);
        }

        // 3. day-end guard
        const health = await getHealth();
        if (health && health.dayEndInProgress) throw new Error('Day-end is running. Try again once it has finished.');

        // 4. database backup
        setStatus({ step: 'backing-up' });
        status.backup = backupDatabase(manifest);
        log(`Database backed up to ${status.backup}`);

        // 5. swap
        setStatus({ step: 'installing' });
        log('Stopping service...');
        stopService();
        await sleep(3000);
        fs.mkdirSync(rollbackDir, { recursive: true });
        swapped = true;
        for (const item of SWAP_ITEMS) {
            const fresh = path.join(stagingDir, item);
            if (!fs.existsSync(fresh)) continue;
            const live = path.join(install, item);
            // Recorded BEFORE moving anything, so a failure half-way through still restores it.
            moved.push(item);
            if (fs.existsSync(live)) await moveWithRetry(live, path.join(rollbackDir, item));
            await moveWithRetry(fresh, live);
            log(`Replaced ${item}`);
        }
        fs.copyFileSync(manifestPath, path.join(install, 'release-manifest.json'));

        // 6. migrations (using the NEW runner and migration files)
        setStatus({ step: 'migrating' });
        const m = run(process.execPath, [path.join(install, 'scripts', 'update', 'run-sql-migrations.js'), '--dir', path.join(install, 'migrations')], { cwd: install });
        log(m.out);
        if (m.code !== 0) throw new Error('Database migration failed; program files will be restored.');

        // 7. start + verify
        setStatus({ step: 'starting' });
        startService();
        if (!(await waitForVersion(manifest.version, HEALTH_TIMEOUT_MS))) {
            throw new Error(`The new version did not report healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`);
        }

        setStatus({ state: 'success', step: 'done', finishedAt: new Date().toISOString() });
        log(`Update to ${manifest.version} complete.`);
        pruneRollbacks();
        fs.rmSync(stagingDir, { recursive: true, force: true });
        try { fs.rmSync(job.zip, { force: true }); } catch { /* keep zip if it cannot be removed */ }
    } catch (e) {
        log(`FAILED: ${e.message}`);
        if (swapped) {
            try {
                await restorePreviousVersion(moved);
                const back = await waitForVersion(fromVersion, HEALTH_TIMEOUT_MS);
                setStatus({
                    state: 'rolled-back', step: 'done', error: e.message, finishedAt: new Date().toISOString(),
                    note: back
                        ? 'The previous version is running again. The database backup is kept.'
                        : 'Previous files were restored but the service did not report healthy: check the service manually.',
                });
                log(back ? 'Rollback complete, previous version is healthy.' : 'Rollback done but service is not healthy.');
            } catch (re) {
                setStatus({ state: 'failed', step: 'done', error: `${e.message} | rollback also failed: ${re.message}`, finishedAt: new Date().toISOString() });
                log(`ROLLBACK FAILED: ${re.message}. Old files are in ${rollbackDir}`);
                process.exitCode = 1;
            }
        } else {
            // Nothing was changed yet (validation / backup failure).
            setStatus({ state: 'failed', step: 'done', error: e.message, finishedAt: new Date().toISOString(), note: 'Nothing was changed.' });
            process.exitCode = 1;
        }
    } finally {
        if (!testMode) run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    }
})();
