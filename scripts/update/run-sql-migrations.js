'use strict';
// Applies database/migrations/*.sql in name order and remembers what it applied in the
// sql_migrations table. This replaces `npm run migration:run` (TypeORM), whose own
// migrations table is out of sync with the real database.
//
//   node scripts/update/run-sql-migrations.js --dir <migrations dir> [--dry-run]
//
// First run on a database that has no sql_migrations table: every file listed in
// <dir>/baseline.txt is recorded as already applied WITHOUT being run. Those are the files
// that must never run twice (overwrite admin-edited values, redo a one-time data fix, or hold
// unguarded DDL such as a bare CREATE TYPE).
// Every other migration is idempotent (IF NOT EXISTS / guarded), so it simply runs once.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : fallback;
}

(async () => {
    const dir = path.resolve(arg('--dir', path.join(__dirname, '..', '..', 'database', 'migrations')));
    const dryRun = process.argv.includes('--dry-run');
    require('./env-file').loadEnvFile(path.join(__dirname, '..', '..', '.env'));
    const { Client } = require('pg');

    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
    });
    await client.connect();

    try {
        // One runner at a time, even if two updates are somehow started together.
        await client.query(`SELECT pg_advisory_lock(hashtext('sql_migrations'))`);

        await client.query(`CREATE TABLE IF NOT EXISTS sql_migrations (
            filename   text PRIMARY KEY,
            checksum   text NOT NULL,
            baseline   boolean NOT NULL DEFAULT false,
            applied_at timestamptz NOT NULL DEFAULT now()
        )`);

        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
        const sums = Object.fromEntries(
            files.map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]),
        );

        const recorded = new Map(
            (await client.query('SELECT filename, checksum FROM sql_migrations')).rows.map((r) => [r.filename, r.checksum]),
        );

        if (recorded.size === 0) {
            const baselineFile = path.join(dir, 'baseline.txt');
            const baseline = fs.existsSync(baselineFile)
                ? fs.readFileSync(baselineFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                : [];
            for (const f of baseline.filter((b) => files.includes(b))) {
                console.log(`[baseline] ${f}`);
                if (!dryRun) {
                    await client.query(
                        'INSERT INTO sql_migrations (filename, checksum, baseline) VALUES ($1, $2, true) ON CONFLICT DO NOTHING',
                        [f, sums[f]],
                    );
                }
                recorded.set(f, sums[f]);
            }
        }

        let applied = 0;
        for (const f of files) {
            if (recorded.has(f)) {
                if (recorded.get(f) !== sums[f]) console.warn(`[warn] ${f} changed since it was applied (not re-run)`);
                continue;
            }
            console.log(`[apply] ${f}`);
            if (dryRun) { applied++; continue; }
            try {
                await client.query('BEGIN');
                await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
                await client.query('INSERT INTO sql_migrations (filename, checksum) VALUES ($1, $2)', [f, sums[f]]);
                await client.query('COMMIT');
                applied++;
            } catch (e) {
                await client.query('ROLLBACK');
                console.error(`[FAILED] ${f}: ${e.message}`);
                process.exitCode = 1;
                return;
            }
        }
        console.log(`Migrations done. Applied ${applied}, already up to date ${files.length - applied}.`);
    } finally {
        await client.end();
    }
})().catch((e) => { console.error('Migration runner error:', e.message); process.exit(1); });
