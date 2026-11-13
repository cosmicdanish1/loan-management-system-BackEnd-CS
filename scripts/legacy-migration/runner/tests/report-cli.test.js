'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewReport } = require('../lib/report');
const { parseArgs, buildOptions } = require('../run-migration');
const spec = require('../lib/spec');
const { QUERIES, countSql, sampleSql } = require('../lib/reportqueries');
const { assertReadOnlySql } = require('../lib/sqlguard');

test('review report: markdown, json and csv carry every line, check and step', () => {
  const r = new ReviewReport({ legacyDatabase: 'EMP_Espat_Society_dan' });
  r.add({ table: 'ledger', section: '23.3', code: 'unbalanced', title: 'vouchers where debits differ from credits', count: 20, samples: ['D00640', 'J06039'], expected: 20 });
  r.add({ table: 'member_master', section: '11.4', code: 'dor', title: 'dor differs', count: 18, samples: ['1 dor=2029'], severity: 'WARN' });
  r.add({ table: 'headmaster', code: 'x', title: 'pipe | and "quote"', severity: 'INFO', samples: ['a"b'] });
  r.check({ name: 'row count', section: '44.3', ok: true, detail: '5 rows' });
  r.check({ name: 'cash', section: '44.3', ok: false, detail: 'differs' });
  r.check({ name: 'smoke', section: '44.3', ok: false, detail: 'note', blocking: false });
  r.step({ no: 1, title: 'castcategorymaster', status: 'OK', rows: 4, seconds: 0.1 });
  assert.equal(r.failedBlockingChecks.length, 1);
  const md = r.toMarkdown();
  assert.match(md, /### ledger/); assert.match(md, /\*\*\[WARN\] vouchers where debits differ from credits\*\*: 20/);
  assert.match(md, /dump reference: 20/); assert.match(md, /e\.g\. `D00640`, `J06039`/);
  assert.match(md, /\| cash \| 44\.3 \| FAIL \|/); assert.match(md, /\| smoke \| 44\.3 \| NOTE \|/); assert.match(md, /pipe \| and "quote"/);
  assert.equal(r.summary().blockingFailed, 1);
  const csv = r.toCsv();
  assert.match(csv, /"ledger","unbalanced","WARN","D00640"/); assert.match(csv, /"a""b"/);
  assert.equal(JSON.parse(JSON.stringify(r.toJSON())).entries.length, 3);
  assert.throws(() => r.add({ table: 't', code: 'c', title: 't', severity: 'FATAL' }));
});

test('CLI options: unknown flags are rejected, execute needs the typed-twice confirmation', () => {
  assert.throws(() => buildOptions(parseArgs(['--nonsense'])), /Unknown flag/);
  assert.throws(() => buildOptions(parseArgs(['--target=x'])), /Unknown option/);
  assert.throws(() => parseArgs(['positional']), /Unexpected argument/);
  const o = buildOptions(parseArgs([]));
  assert.equal(o.execute, false); assert.equal(o.targetDb, undefined); // dry run, no default target
  const e = buildOptions(parseArgs(['--execute', '--target-db=a', '--confirm-target=b']));
  assert.equal(e.execute, true); assert.notEqual(e.targetDb, e.confirmTarget);
});

test('spec: 15 steps in order, every copy table is in exactly one step, sections are named', () => {
  assert.deepEqual(spec.STEPS.map(s => s.no), Array.from({ length: 15 }, (_, i) => i + 1));
  for (const s of spec.STEPS) { assert.ok(s.sections && s.title && s.stops); }
  const inSteps = spec.STEPS.filter(s => s.kind.startsWith('copy')).flatMap(s => s.tables).sort();
  assert.deepEqual(inSteps, spec.COPY_TABLES.map(t => t.id).sort());
  for (const t of spec.COPY_TABLES) assert.ok(t.section && t.dump > 0 && /^(physloc|key:\w+)$/.test(t.order), t.id);
  assert.equal(spec.byId.ledger.order, 'key:LedgerId'); assert.equal(spec.byId.ledger.orderedHash, true);
  assert.equal(spec.COPY_TABLES.length, 34);
  // user tables and the test-database tables are never copied
  for (const never of ['usermaster', 'userinfo', 'userrights', 'logintime', 'accountbalance', 'balancesheet', 'tblcashbook', 'member_balances']) assert.equal(spec.byId[never], undefined, never);
});

test('every report query and the derived SQL passes the legacy read-only guard', () => {
  for (const q of QUERIES) { assert.ok(assertReadOnlySql(countSql(q)), q.id); assert.ok(assertReadOnlySql(sampleSql(q) + ' FOR JSON PATH'), q.id); }
  assert.ok(QUERIES.length >= 40);
  assert.equal(new Set(QUERIES.map(q => q.id)).size, QUERIES.length);
});
