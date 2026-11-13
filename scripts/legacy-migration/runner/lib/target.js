'use strict';
// Postgres access with two strict modes.
//  * read-only (dry-run --check-target): the session is set to default_transaction_read_only=on and every
//    statement passes assertReadOnlyPg. Nothing can be written even by mistake.
//  * writable (--execute only): writes are possible, and only through write()/begin()/commit().
// The password is read from the environment or the project's own config files at connect time only; it is
// never logged, printed or put into any report.
const fs = require('node:fs');
const path = require('node:path');
const { assertReadOnlyPg } = require('./sqlguard');

const BACKEND = path.resolve(__dirname, '../../../..');

function loadConfig(opts = {}) {
  const env = { ...process.env };
  let file = {};
  const configPath = env.DB_CONFIG_PATH || path.join(BACKEND, 'db-config.json');
  try { if (fs.existsSync(configPath)) file = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '')); } catch { file = {}; }
  let dotenv = {};
  try { const p = path.join(BACKEND, '.env'); if (fs.existsSync(p)) dotenv = require('dotenv').parse(fs.readFileSync(p)); } catch { dotenv = {}; }
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');
  if (!opts.database) throw new Error('A target database name is required (--target-db). There is no default, on purpose.');
  return {
    host: pick(env.MIG_PG_HOST, file.host, dotenv.DB_HOST, 'localhost'),
    port: Number(pick(env.MIG_PG_PORT, file.port, dotenv.DB_PORT, 5432)),
    user: pick(env.MIG_PG_USER, file.username, dotenv.DB_USERNAME, 'postgres'),
    password: pick(env.MIG_PG_PASSWORD, file.password, dotenv.DB_PASSWORD),
    database: opts.database,
    ssl: pick(env.MIG_PG_SSL, file.ssl, dotenv.DB_SSL) === true || pick(env.MIG_PG_SSL, file.ssl, dotenv.DB_SSL) === 'true',
    connectionTimeoutMillis: 10000,
    application_name: 'legacy-migration-runner',
  };
}

class Target {
  constructor(config, { writable = false } = {}) { this.config = config; this.writable = writable; this.client = null; this.inTx = false; }

  async connect() {
    const { Client, types } = require('pg');
    types.setTypeParser(1114, v => v); // timestamp without time zone: keep text exactly
    types.setTypeParser(1082, v => v); // date
    this.client = new Client(this.config);
    await this.client.connect();
    if (!this.writable) await this.client.query("SET default_transaction_read_only=on; SET statement_timeout='300s'; SET lock_timeout='10s'");
    else await this.client.query("SET statement_timeout=0; SET lock_timeout='30s'");
    return this;
  }

  get database() { return this.config.database; }

  /** Reads: allowed in both modes, always guarded. */
  async read(sql, params) { assertReadOnlyPg(sql); return (await this.client.query(sql, params)).rows; }
  async scalar(sql, params) { const r = await this.read(sql, params); return r[0] ? Object.values(r[0])[0] : null; }

  /** Writes: refused unless this Target was opened writable (which only --execute does). */
  async write(sql, params) {
    if (!this.writable) throw new Error('Refusing to write: target was opened read-only (dry-run).');
    return this.client.query(sql, params);
  }
  async begin() { await this.write('BEGIN'); this.inTx = true; }
  async commit() { await this.write('COMMIT'); this.inTx = false; }
  async rollback() { if (this.client && this.inTx) { await this.client.query('ROLLBACK').catch(() => {}); this.inTx = false; } }

  async columns(table) {
    return this.read(`SELECT column_name AS name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  }
  async tableExists(table) { return (await this.read("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 AND table_type='BASE TABLE'", [table])).length > 0; }
  async count(table) { return Number(await this.scalar(`SELECT count(*)::text FROM "${table.replace(/"/g, '""')}"`)); }
  async hasRows(table) { return (await this.read(`SELECT 1 FROM "${table.replace(/"/g, '""')}" LIMIT 1`)).length > 0; }

  /** Stream a SELECT in batches through a cursor (inside a transaction on a writable connection; read-only: own tx). */
  async *cursor(sql, batch = 20000) {
    assertReadOnlyPg(sql);
    const own = !this.inTx;
    if (own) await this.client.query('BEGIN READ ONLY');
    try {
      await this.client.query(`DECLARE mig_cur NO SCROLL CURSOR FOR ${sql}`);
      for (;;) {
        const rows = (await this.client.query(`FETCH ${batch} FROM mig_cur`)).rows;
        if (!rows.length) break;
        yield rows;
      }
      await this.client.query('CLOSE mig_cur');
    } finally { if (own) await this.client.query('ROLLBACK').catch(() => {}); }
  }

  async end() { if (this.client) await this.client.end().catch(() => {}); this.client = null; }
}

const pgq = v => '"' + String(v).replace(/"/g, '""') + '"';

module.exports = { Target, loadConfig, pgq };
