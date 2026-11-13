'use strict';
// Read-only access to the legacy MS SQL database through sqlcmd (Windows integrated auth: no password is used
// or stored anywhere). The server name is built with String.fromCharCode(92) so no backslash is ever typed in
// a command line. Every statement is checked by sqlguard.assertReadOnlySql before it leaves this process.
const { spawnSync } = require('node:child_process');
const { assertReadOnlySql } = require('./sqlguard');

const msQuote = v => '[' + String(v).replace(/]/g, ']]') + ']';
const msLiteral = v => "N'" + String(v).replace(/'/g, "''") + "'";
const DEFAULT_SERVER = '.' + String.fromCharCode(92) + 'SQLEXPRESS';

class Legacy {
  constructor({ server = process.env.LEGACY_SERVER || DEFAULT_SERVER, database = process.env.LEGACY_DB || 'EMP_Espat_Society_dan', runner = null } = {}) {
    this.server = server; this.database = database; this.runner = runner; // runner: test seam (sql) => stdout text
    this.queries = 0;
  }

  _exec(sql) {
    assertReadOnlySql(sql);
    this.queries++;
    if (this.runner) return this.runner(sql);
    const r = spawnSync('sqlcmd', [
      '-S', this.server, '-d', this.database, '-E', '-l', '10', '-t', '900',
      '-b', '-r', '1', '-y', '0', '-w', '65535', '-f', '65001',
      '-Q', 'SET NOCOUNT ON; SET LOCK_TIMEOUT 10000; ' + sql,
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, timeout: 930000 });
    if (r.error) throw r.error;
    if (r.signal) throw new Error(`sqlcmd terminated by ${r.signal}`);
    if (r.status !== 0 || r.stderr.trim()) throw new Error(`sqlcmd failed (exit ${r.status}): ${(r.stderr.trim() || r.stdout.trim()).slice(0, 400)}`);
    return r.stdout;
  }

  /** Run a SELECT ... FOR JSON PATH, INCLUDE_NULL_VALUES query and return the parsed rows. */
  rows(sqlWithoutForJson) {
    const out = this._exec(`${sqlWithoutForJson} FOR JSON PATH, INCLUDE_NULL_VALUES`);
    const text = out.replace(/\r?\n/g, '').replace(/^﻿/, '').trim();
    return text ? JSON.parse(text) : [];
  }

  /** Single-value convenience: first column of first row as given by JSON. */
  scalar(sql) { const r = this.rows(sql)[0]; return r ? Object.values(r)[0] : null; }

  columns(table) {
    return this.rows(`SELECT c.name, ty.name AS type, c.column_id AS ordinal FROM sys.tables t
      JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id
      WHERE t.name=${msLiteral(table)} ORDER BY c.column_id`);
  }
}

/** SELECT-list expression that returns every value in the text form used by canon.js (numerics and dates as exact text). */
function selectExpr(col, alias) {
  const c = msQuote(col.name), a = msQuote(alias || col.name);
  const t = String(col.type).toLowerCase();
  if (['numeric', 'decimal', 'money', 'smallmoney', 'bigint'].includes(t)) return `CONVERT(varchar(100),${c}) AS ${a}`;
  if (['datetime', 'datetime2', 'smalldatetime', 'date', 'time'].includes(t)) return `CONVERT(varchar(40),${c},126) AS ${a}`;
  if (['varbinary', 'binary', 'image'].includes(t)) return `CONVERT(varchar(max),${c},2) AS ${a}`;
  return `${c} AS ${a}`;
}

module.exports = { Legacy, msQuote, msLiteral, selectExpr, DEFAULT_SERVER };
