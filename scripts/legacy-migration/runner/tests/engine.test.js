'use strict';
// End-to-end tests of the copy engine, the guards and the pre-flight with an in-memory legacy and an in-memory
// target. No database of any kind is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Legacy } = require('../lib/legacy');
const { Target } = require('../lib/target');
const { copyTable, legacyBatches, legacyBaseline } = require('../lib/engine');
const { ReviewReport } = require('../lib/report');
const pre = require('../lib/preflight');
const spec = require('../lib/spec');

// ---------------------------------------------------------------- fake legacy (answers the SQL shapes the engine sends)
function fakeLegacy(tables) {
  // tables: { NAME: { cols:[{name,type}], rows:[{col:value}] } }
  const runner = sql => {
    const s = sql.replace(/\s+/g, ' ').replace(/ FOR JSON PATH, INCLUDE_NULL_VALUES$/, '');
    let m;
    if ((m = /FROM sys\.tables t JOIN sys\.columns c.*t\.name=N'([^']+)'/.exec(s))) {
      const t = tables[m[1].toLowerCase()];
      return JSON.stringify((t ? t.cols : []).map((c, i) => ({ name: c.name, type: c.type, ordinal: i + 1 })));
    }
    if ((m = /SELECT CONVERT\(varchar\(30\),COUNT_BIG\(\*\)\) AS n(.*) FROM \[dbo\]\.\[([^\]]+)\]/.exec(s))) {
      const t = tables[m[2].toLowerCase()];
      const out = { n: String(t.rows.length) };
      for (const sm of m[1].matchAll(/SUM\(CAST\(\[([^\]]+)\] AS decimal\(38,6\)\)\)\) AS (s\d+)/g)) out[sm[2]] = String(t.rows.reduce((a, r) => a + Number(r[sm[1]]), 0));
      return JSON.stringify([out]);
    }
    if ((m = /SELECT TOP \((\d+)\) (.*) FROM \[dbo\]\.\[([^\]]+)\] (.*)$/.exec(s))) {
      const n = Number(m[1]), t = tables[m[3].toLowerCase()];
      const key = /ORDER BY \[([^\]]+)\]$/.exec(m[4]);
      const after = /WHERE \[[^\]]+\] > (\S+) ORDER/.exec(m[4]);
      const afterPl = /WHERE %%physloc%% > CONVERT\(binary\(8\), '(0x[0-9A-F]+)', 1\)/.exec(m[4]);
      let idx = t.rows.map((r, i) => ({ r, i }));
      if (key) { idx.sort((a, b) => Number(a.r[key[1]]) - Number(b.r[key[1]])); if (after) idx = idx.filter(x => Number(x.r[key[1]]) > Number(after[1])); }
      else if (afterPl) idx = idx.filter(x => x.i > parseInt(afterPl[1].slice(2, 6), 16));
      idx = idx.slice(0, n);
      const aliases = [...m[2].matchAll(/AS \[([^\]]+)\]/g)].map(x => x[1]).filter(x => x !== '__pl');
      return JSON.stringify(idx.map(({ r, i }) => ({ ...Object.fromEntries(t.cols.map((c, ci) => [aliases[ci], r[c.name] === null ? null : String(r[c.name])])), ...(key ? {} : { __pl: '0x' + i.toString(16).padStart(4, '0') + '000000000000' }) })));
    }
    throw new Error('fakeLegacy: unhandled SQL: ' + s.slice(0, 160));
  };
  return new Legacy({ runner, database: 'fake' });
}

// ---------------------------------------------------------------- fake target
class FakeTarget extends Target {
  constructor({ writable = true, schema = {}, existing = {} } = {}) {
    super({ database: 'fake_target' }, { writable });
    this.schema = schema; this.store = JSON.parse(JSON.stringify(existing)); this.writes = []; this.tamper = null;
  }
  async columns(t) { return (this.schema[t] || []).map(c => ({ name: c.name, data_type: c.type, udt_name: c.type, is_nullable: 'YES' })); }
  async hasRows(t) { return (this.store[t] || []).length > 0; }
  async count(t) { return (this.store[t] || []).length; }
  async tableExists(t) { return !!this.schema[t]; }
  async read(sql) {
    let m;
    if ((m = /SELECT "([^"]+)"::text AS k FROM "([^"]+)"/.exec(sql))) return (this.store[m[2]] || []).map(r => ({ k: r[m[1]] }));
    throw new Error('FakeTarget.read unhandled: ' + sql);
  }
  async scalar(sql) {
    const m = /coalesce\(sum\("([^"]+)"\),0\)::text FROM "([^"]+)"/.exec(sql);
    if (m) return String((this.store[m[2]] || []).reduce((a, r) => a + Number(r[m[1]]), 0));
    throw new Error('FakeTarget.scalar unhandled: ' + sql);
  }
  async write(sql, params) {
    if (!this.writable) throw new Error('Refusing to write: target was opened read-only (dry-run).');
    const m = /^INSERT INTO "([^"]+)" \(([^)]*)\) VALUES (.*)$/s.exec(sql);
    if (!m) throw new Error('FakeTarget.write unhandled: ' + sql.slice(0, 80));
    const cols = m[2].split(',').map(c => c.replace(/"/g, ''));
    this.writes.push(sql);
    for (let i = 0; i < params.length; i += cols.length) {
      const row = {}; cols.forEach((c, j) => { row[c] = params[i + j] === null ? null : String(params[i + j]); });
      (this.store[m[1]] = this.store[m[1]] || []).push(row);
    }
  }
  async *cursor(sql) {
    const m = /FROM "([^"]+)"/.exec(sql);
    let rows = (this.store[m[1]] || []).map(r => ({ ...r }));
    if (this.tamper) rows = this.tamper(rows);
    const o = /ORDER BY "([^"]+)"/.exec(sql);
    if (o) rows.sort((a, b) => Number(a[o[1]]) - Number(b[o[1]]));
    for (let i = 0; i < rows.length; i += 2) yield rows.slice(i, i + 2);
  }
}

const ctxOf = (legacy, target) => ({ legacy, target, execute: true, report: new ReviewReport(), opts: {}, baseline: null, state: {}, log() {} });

const LEDGER = [{ LedgerId: '5', TRANS_NO: '1', CODE: 'A1', TRANS_AMT: '10.50', TRANS_TYPE: 'DR' }, { LedgerId: '2', TRANS_NO: '1', CODE: 'B1', TRANS_AMT: '10.5', TRANS_TYPE: 'CR' },
  { LedgerId: '9', TRANS_NO: '2', CODE: 'A1', TRANS_AMT: '3', TRANS_TYPE: 'DR' }, { LedgerId: '11', TRANS_NO: '2', CODE: 'C1', TRANS_AMT: '3', TRANS_TYPE: 'CR' }, { LedgerId: '12', TRANS_NO: '3', CODE: 'A1', TRANS_AMT: '0', TRANS_TYPE: 'DR' }];
const legacyTables = () => ({
  ledger: { cols: [{ name: 'TRANS_NO', type: 'int' }, { name: 'CODE', type: 'varchar' }, { name: 'TRANS_TYPE', type: 'varchar' }, { name: 'TRANS_AMT', type: 'money' }, { name: 'LedgerId', type: 'int' }], rows: LEDGER },
});
const pgCols = [{ name: 'trans_no', type: 'integer' }, { name: 'code', type: 'character varying' }, { name: 'trans_type', type: 'character varying' }, { name: 'trans_amt', type: 'numeric' }, { name: 'ledgerid', type: 'integer' }];
const LEDGER_SPEC = { id: 'ledger', legacy: 'ledger', section: '23', dump: 5, order: 'key:LedgerId', sums: ['TRANS_AMT'], batch: 2, orderedHash: true };

test('copyTable: pages by key in batches, inserts every row exactly once, verifies count, sum and SHA-256', async () => {
  const target = new FakeTarget({ schema: { ledger: pgCols } });
  const rec = await copyTable(ctxOf(fakeLegacy(legacyTables()), target), LEDGER_SPEC);
  assert.equal(rec.inserted, 5);
  assert.equal((target.store.ledger || []).length, 5);
  assert.equal(rec.sha256, rec.loadedSha256);
  assert.deepEqual(target.store.ledger.map(r => r.ledgerid), ['2', '5', '9', '11', '12']); // batches of 2 in LedgerId order, nothing repeated
  assert.ok(target.writes.every(w => w.startsWith('INSERT INTO'))); // insert only: no DELETE/UPDATE/TRUNCATE ever sent
});

test('copyTable: a changed value in the target is caught by the SHA-256 even when count and sum are unchanged', async () => {
  const target = new FakeTarget({ schema: { ledger: pgCols } });
  target.tamper = rows => { rows[0].code = 'ZZ'; return rows; };
  await assert.rejects(copyTable(ctxOf(fakeLegacy(legacyTables()), target), LEDGER_SPEC), /SHA-256 of the loaded rows differs/);
});

test('copyTable: a missing row and a moved amount are caught', async () => {
  let target = new FakeTarget({ schema: { ledger: pgCols } });
  target.tamper = rows => rows.slice(1);
  await assert.rejects(copyTable(ctxOf(fakeLegacy(legacyTables()), target), LEDGER_SPEC), /row count: loaded 4, expected 5/);
  target = new FakeTarget({ schema: { ledger: pgCols } });
  target.tamper = rows => { rows[1].trans_amt = '10.51'; return rows; };
  await assert.rejects(copyTable(ctxOf(fakeLegacy(legacyTables()), target), LEDGER_SPEC), /differs|sum of TRANS_AMT/);
});

test('copyTable: ordered hash catches rows loaded in a different order than LedgerId (identical multiset)', async () => {
  const target = new FakeTarget({ schema: { ledger: pgCols } });
  // swap two rows' ledgerids so the multiset of full rows changes order-sensitively: reversing the cursor order
  const orig = target.cursor.bind(target);
  target.cursor = async function* (sql) { const all = []; for await (const b of orig(sql)) all.push(...b); all.reverse(); yield all; };
  await assert.rejects(copyTable(ctxOf(fakeLegacy(legacyTables()), target), LEDGER_SPEC), /ordered SHA-256/);
});

test('copyTable refuses a non-empty target (no delete step exists) and schema drift', async () => {
  const dirty = new FakeTarget({ schema: { ledger: pgCols }, existing: { ledger: [{ ledgerid: '1' }] } });
  await assert.rejects(copyTable(ctxOf(fakeLegacy(legacyTables()), dirty), LEDGER_SPEC), /not empty/);
  const drift = new FakeTarget({ schema: { ledger: pgCols.filter(c => c.name !== 'code') } });
  await assert.rejects(copyTable(ctxOf(fakeLegacy(legacyTables()), drift), LEDGER_SPEC), /SCHEMA DRIFT.*CODE/);
  assert.equal(dirty.writes.length + drift.writes.length, 0);
});

test('a read-only target cannot write; the writer refuses too', async () => {
  const ro = new FakeTarget({ writable: false, schema: { ledger: pgCols } });
  await assert.rejects(copyTable(ctxOf(fakeLegacy(legacyTables()), ro), LEDGER_SPEC), /Refusing to write/);
  const real = new Target({ database: 'x' }, { writable: false });
  await assert.rejects(real.write('INSERT INTO t VALUES (1)'), /Refusing to write/);
  await assert.rejects(real.begin(), /Refusing to write/);
});

test('insert-missing tables keep seeded rows and compare only their own rows (headmaster I1013/I1014)', async () => {
  const L = { headmaster: { cols: [{ name: 'CODE', type: 'varchar' }, { name: 'PFLAG', type: 'varchar' }, { name: 'OP_BAL', type: 'money' }], rows: [{ CODE: 'A1048', PFLAG: '', OP_BAL: '0' }, { CODE: 'L1', PFLAG: 'L', OP_BAL: '5' }] } };
  const cols = [{ name: 'code', type: 'character varying' }, { name: 'pflag', type: 'character varying' }, { name: 'op_bal', type: 'numeric' }];
  const target = new FakeTarget({ schema: { headmaster: cols }, existing: { headmaster: [{ code: 'I1013', pflag: 'I', op_bal: '0' }, { code: 'I1014', pflag: 'I', op_bal: '0' }] } });
  const { fixHeadPflag } = require('../lib/derive');
  const rec = await copyTable(ctxOf(fakeLegacy(L), target), { ...spec.byId.headmaster, batch: 10 }, { transform: row => fixHeadPflag(row).row });
  assert.equal(rec.inserted, 2); assert.equal(target.store.headmaster.length, 4);
  assert.equal(target.store.headmaster.find(r => r.code === 'A1048').pflag, 'A'); // the one change, applied
});

test('baseline streams the whole table and is stable (same data, same SHA-256)', () => {
  const a = legacyBaseline(fakeLegacy(legacyTables()), LEDGER_SPEC), b = legacyBaseline(fakeLegacy(legacyTables()), LEDGER_SPEC);
  assert.equal(a.rows, 5); assert.equal(a.sha256, b.sha256); assert.equal(a.sums.TRANS_AMT, '27');
  const t = legacyTables(); t.ledger.rows[0].CODE = 'Q1';
  assert.notEqual(legacyBaseline(fakeLegacy(t), LEDGER_SPEC).sha256, a.sha256);
});

test('legacy paging yields every row exactly once for physical-order tables', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ A: String(i) }));
  const L = fakeLegacy({ small: { cols: [{ name: 'A', type: 'int' }], rows } });
  const cols = [{ source: { name: 'A', type: 'int' }, name: 'a', kind: 'num' }];
  const got = [];
  for (const b of legacyBatches(L, { legacy: 'small', order: 'physloc' }, cols, 3)) got.push(...b.map(r => r.a));
  assert.deepEqual(got, rows.map(r => r.A));
});

// ---------------------------------------------------------------- empty-target guard (44.1(4))
class GuardTarget extends FakeTarget {
  constructor(tables, rowsByTable) { super({ writable: false }); this.tables = tables; this.rowsByTable = rowsByTable; }
  async scalar(sql) { if (/current_database/.test(sql)) return 'prod'; return null; }
  async hasRows(t) { return (this.rowsByTable[t] || []) .length > 0; }
  async columns() { return []; }
  async read(sql, params) {
    if (/information_schema\.tables/.test(sql)) return this.tables.map(n => ({ n }));
    if (/SELECT count\(\*\)::int AS c FROM "headmaster"/.test(sql)) return [{ c: (this.rowsByTable.headmaster || []).filter(r => !params[0].includes(r)).length }];
    if (/FROM sequence_master/.test(sql)) return ['LOAN_CASE', 'MEMBER_NO', 'VOUCHER_NO'].map(k => ({ k }));
    if (/pg_trigger/.test(sql)) return [{ x: 1 }];
    if (/FROM migrations/.test(sql)) return [];
    return [];
  }
}
const allTables = [...spec.COPY_TABLES.map(t => t.id), ...spec.GROUP_DERIVED, ...spec.CONFIG_TABLES, 'license_keys', 'usermaster'];
const guardCtx = target => ({ legacy: { columns: () => [] }, target, opts: { targetDb: 'prod', migrationsDir: __dirname }, state: {}, report: new ReviewReport() });

test('empty-target guard: a clean template passes; a table with rows, license_keys or a user refuses the run', async () => {
  const config = Object.fromEntries(spec.CONFIG_TABLES.map(n => [n, [1]]));
  const clean = await pre.targetPreflight(guardCtx(new GuardTarget(allTables, { ...config, headmaster: ['I1013', 'I1014'] })));
  assert.equal(clean.find(c => c.name.startsWith('EMPTY-TARGET')).ok, true);
  for (const dirtyTable of ['ledger', 'license_keys', 'usermaster', 'member_master']) {
    const res = await pre.targetPreflight(guardCtx(new GuardTarget(allTables, { ...config, [dirtyTable]: [1] })));
    const g = res.find(c => c.name.startsWith('EMPTY-TARGET'));
    assert.equal(g.ok, false, dirtyTable); assert.equal(g.blocking, true); assert.match(g.detail, new RegExp(dirtyTable));
  }
  const seeded = await pre.targetPreflight(guardCtx(new GuardTarget(allTables, { ...config, headmaster: ['I1013', 'A1001'] })));
  assert.equal(seeded.find(c => c.name.startsWith('EMPTY-TARGET')).ok, false); // a real head already present is not seeded data
});

test('blocker pre-flight inputs: busrules values and go-live date', () => {
  const none = pre.inputChecks({ opts: {} });
  assert.deepEqual(none.map(c => c.ok), [false, false]);
  assert.ok(none.every(c => c.blocking));
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const f = path.join(os.tmpdir(), 'society-values-test.json');
  fs.writeFileSync(f, JSON.stringify({ elnpenalrate: '3', alnpenalrate: '3', rlngracedays: '0', elngracedays: '0', alngracedays: '0', rlnsmpct: '1', elnsmpct: '1', alnsmpct: '1', rlnsmdiv: '4', elnsmdiv: '4', alnsmdiv: '4' }));
  assert.deepEqual(pre.inputChecks({ opts: { societyValuesFile: f, goLiveDate: '2026-11-04' } }).map(c => c.ok), [true, true]);
  fs.writeFileSync(f, JSON.stringify({ elnpenalrate: '3' }));
  assert.equal(pre.inputChecks({ opts: { societyValuesFile: f, goLiveDate: '2026-11-04' } })[0].ok, false);
  fs.unlinkSync(f);
});
