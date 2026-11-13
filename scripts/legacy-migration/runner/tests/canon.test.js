'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const canon = require('../lib/canon');
const { mapColumns } = require('../lib/colmap');
const { assertReadOnlySql, assertReadOnlyPg } = require('../lib/sqlguard');

test('canonical values: source strings and target strings hash identically', () => {
  assert.equal(canon.canonValue('1234.5600', 'num'), canon.canonValue('1234.56', 'num'));
  assert.equal(canon.canonValue('2019-11-01T00:00:00', 'ts'), canon.canonValue('2019-11-01 00:00:00', 'ts'));
  assert.equal(canon.canonValue('2019-11-01T10:11:12.120', 'ts'), canon.canonValue('2019-11-01 10:11:12.12', 'ts'));
  assert.equal(canon.canonValue('2019-11-01T00:00:00.000', 'date'), '2019-11-01');
  assert.equal(canon.canonValue(null, 'num'), null);
  assert.equal(canon.canonValue(7, 'float'), 7);
  assert.equal(canon.canonValue('abc ', 'str'), 'abc ');
  assert.equal(canon.kindOfPg('numeric'), 'num'); assert.equal(canon.kindOfPg('timestamp without time zone'), 'ts');
  assert.equal(canon.kindOfMssql('money'), 'num'); assert.equal(canon.kindOfMssql('nvarchar'), 'str'); assert.equal(canon.kindOfMssql('float'), 'float');
});

test('multiset fingerprint: order independent, detects changes and duplicates', () => {
  const cols = [{ name: 'a', kind: 'num' }, { name: 'b', kind: 'str' }];
  const rows = [{ a: '1.50', b: 'x' }, { a: '2', b: 'y' }, { a: '2', b: 'y' }];
  const fp = list => list.reduce((f, r) => f.add(canon.canonRow(r, cols)), new canon.MultisetFingerprint());
  const f1 = fp(rows), f2 = fp([rows[2], rows[0], rows[1]]);
  assert.equal(f1.hex(), f2.hex()); assert.equal(f1.count, 3);
  assert.notEqual(f1.hex(), fp([rows[0], rows[1]]).hex());                       // fewer rows
  assert.notEqual(f1.hex(), fp([rows[0], rows[1], { a: '3', b: 'y' }]).hex());   // changed row
  assert.equal(fp([{ a: '1.5', b: 'x' }]).hex(), fp([{ a: '1.50', b: 'x' }]).hex());
});

test('ordered hash depends on order', () => {
  const cols = [{ name: 'a', kind: 'num' }];
  const h = list => list.reduce((x, r) => x.add(canon.canonRow(r, cols)), new canon.OrderedHash()).hex();
  assert.notEqual(h([{ a: 1 }, { a: 2 }]), h([{ a: 2 }, { a: 1 }]));
  assert.equal(h([{ a: 1 }, { a: 2 }]), h([{ a: '1.0' }, { a: '2' }]));
});

test('column mapping: shared, drift (blocks) and target-only columns', () => {
  const src = [{ name: 'MBNO', type: 'numeric' }, { name: 'Amount', type: 'money' }, { name: 'OldCol', type: 'varchar' }];
  const tgt = [{ name: 'mbno', data_type: 'numeric' }, { name: 'amount', data_type: 'numeric' }, { name: 'loancaseno', data_type: 'numeric' }];
  const m = mapColumns(src, tgt);
  assert.deepEqual(m.shared.map(c => c.name), ['mbno', 'amount']);
  assert.deepEqual(m.missingInTarget, ['OldCol']);
  assert.deepEqual(m.targetOnly, ['loancaseno']);
  assert.equal(m.shared[0].kind, 'num');
  assert.deepEqual(mapColumns([{ name: 'Mbno', type: 'numeric' }], [{ name: 'mbno', data_type: 'numeric' }], {}).missingInTarget, []);
});

test('legacy SQL guard accepts reads and refuses everything that could write', () => {
  assert.ok(assertReadOnlySql("SET NOCOUNT ON; SET LOCK_TIMEOUT 10000; SELECT a FROM [dbo].[LEDGER] WHERE x='delete me' FOR JSON PATH"));
  assert.ok(assertReadOnlySql('WITH c AS (SELECT 1 AS a) SELECT * FROM c'));
  assert.ok(assertReadOnlySql('SELECT UPDATEGL_FLAG, [Update] FROM t'));
  for (const bad of ['DELETE FROM t', 'UPDATE t SET a=1', 'SELECT * INTO x FROM t', 'SELECT 1; DROP TABLE t', 'EXEC sp_who', 'SELECT 1; EXEC xp_cmdshell 1',
    'INSERT t VALUES (1)', 'TRUNCATE TABLE t', 'SET IDENTITY_INSERT t ON', 'USE master', 'SELECT * FROM OPENROWSET(1)', 'DECLARE @a int', '']) {
    assert.throws(() => assertReadOnlySql(bad), undefined, bad);
  }
});

test('postgres read-only guard refuses writes and locks', () => {
  assert.ok(assertReadOnlyPg("SELECT count(*) FROM ledger WHERE narration = 'delete'"));
  for (const bad of ['DELETE FROM ledger', 'INSERT INTO t VALUES (1)', 'SELECT nextval(\'x\')', 'TRUNCATE t', 'COPY t TO STDOUT', 'SELECT 1; DROP TABLE t', 'SELECT pg_advisory_lock(1)', 'SET x=1']) {
    assert.throws(() => assertReadOnlyPg(bad), undefined, bad);
  }
});
