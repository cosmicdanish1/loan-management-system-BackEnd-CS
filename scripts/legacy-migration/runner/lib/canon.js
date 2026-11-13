'use strict';
// Canonical row images and SHA-256 fingerprints. The same canonicalisation is applied to the legacy side
// (strings from sqlcmd/JSON) and to the Postgres side (strings from pg with type parsers off), so equal
// data always hashes equal and different data never does.
const crypto = require('node:crypto');
const dec = require('./dec');

function kindOfPg(type, udt) {
  const t = String(type || udt || '').toLowerCase();
  if (['numeric', 'decimal', 'smallint', 'integer', 'bigint', 'int2', 'int4', 'int8', 'money'].includes(t)) return 'num';
  if (['real', 'double precision', 'float4', 'float8'].includes(t)) return 'float';
  if (t.startsWith('timestamp')) return 'ts';
  if (t === 'date') return 'date';
  if (t === 'bytea') return 'bytes';
  if (t === 'boolean') return 'bool';
  return 'str';
}

function kindOfMssql(type) {
  const t = String(type || '').toLowerCase();
  if (['numeric', 'decimal', 'money', 'smallmoney', 'bigint', 'int', 'smallint', 'tinyint'].includes(t)) return 'num';
  if (['float', 'real'].includes(t)) return 'float';
  if (['datetime', 'datetime2', 'smalldatetime'].includes(t)) return 'ts';
  if (t === 'date') return 'date';
  if (['varbinary', 'binary', 'image'].includes(t)) return 'bytes';
  if (t === 'bit') return 'bool';
  return 'str';
}

function canonTimestamp(value) {
  let s = String(value).trim().replace(' ', 'T');
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?)?/.exec(s);
  if (!m) return s;
  const frac = (m[3] || '').replace(/0+$/, '');
  return `${m[1]}T${m[2] || '00:00:00'}${frac ? '.' + frac : ''}`;
}

/** Canonical value for one cell, by the TARGET column kind. */
function canonValue(value, kind) {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'num': return dec.normalize(value);
    case 'float': return Number(value);
    case 'ts': return canonTimestamp(value);
    case 'date': return canonTimestamp(value).slice(0, 10);
    case 'bytes': return Buffer.isBuffer(value) ? value.toString('base64') : String(value);
    case 'bool': return value === true || value === 't' || value === 'true' || value === 1 || value === '1';
    default: return String(value);
  }
}

/** columns: [{ name, kind }] -> array image of the row */
function canonRow(row, columns) {
  return columns.map(c => canonValue(row[c.name], c.kind));
}

const rowDigest = canon => crypto.createHash('sha256').update(JSON.stringify(canon)).digest();

/**
 * Order-independent multiset fingerprint: sum of per-row SHA-256 (BigInt addition, not XOR, so duplicate
 * rows cannot cancel). Same method as migrate-all-members.js, so numbers are comparable with earlier runs.
 */
class MultisetFingerprint {
  constructor() { this.sum = 0n; this.count = 0; }
  add(canon) { this.sum += BigInt('0x' + rowDigest(canon).toString('hex')); this.count++; return this; }
  hex() { return this.sum.toString(16); }
  toJSON() { return { rows: this.count, sha256: this.hex() }; }
}

/** Order-dependent hash (used for the ledger in LedgerId order): one SHA-256 over all row images. */
class OrderedHash {
  constructor() { this.h = crypto.createHash('sha256'); this.count = 0; }
  add(canon) { this.h.update(JSON.stringify(canon)); this.h.update('\n'); this.count++; return this; }
  hex() { return this.h.copy().digest('hex'); }
  toJSON() { return { rows: this.count, sha256: this.hex() }; }
}

module.exports = { kindOfPg, kindOfMssql, canonValue, canonRow, canonTimestamp, MultisetFingerprint, OrderedHash };
