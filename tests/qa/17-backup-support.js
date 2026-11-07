// Backup (create + verify only, NO restore, NO cleanup) and Support Desk. The only files written are the backup this suite creates
// in F:\company\qa-backup-test, which the suite removes at the end (its own file). One support query is created (labelled QA).
const fs = require('fs'), path = require('path');
const { http, login, Suite } = require('./lib');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

(async () => {
  const s = new Suite('17-backup-support');
  const { token } = await login();
  const call = (m, u, b, t = 900000) => http(m, u, { token, body: b, timeout: t });
  const dest = 'F:\\company\\qa-backup-test';
  fs.mkdirSync(dest, { recursive: true });

  const tc = await call('GET', '/backup/test-connection');
  s.check('BK-01', 'Backup test-connection works', tc.status === 200 && tc.json && tc.json.data && tc.json.data.connected === true, `${tc.status} ${(tc.text || '').slice(0, 100)}`);
  const di = await call('GET', '/backup/database-info');
  s.check('BK-02', 'database-info works', di.status === 200, `${di.status} ${(di.text || '').slice(0, 160)}`);
  const lst = await call('GET', '/backup/list');
  const n = lst.json && lst.json.data && lst.json.data.length;
  s.check('BK-03', `Backup list answers within 5 s (${n} backups, ${lst.ms} ms)`, lst.status === 200 && lst.ms < 5000, `${lst.status} ${lst.ms}ms`);
  for (const [id, t, p] of [['BK-04', 'a Windows system folder', 'C:\\Windows\\System32'], ['BK-05', 'a UNC path', '\\\\evil-host\\share'], ['BK-06', 'a relative traversal', '..\\..\\..\\Windows'], ['BK-07', 'an empty path', ''], ['BK-08', 'a path with illegal characters', 'F:\\x<>|?*']]) {
    const r = await call('POST', '/backup/validate-destination', { destinationPath: p });
    s.check(id, `validate-destination for ${t} is not "valid"`, r.status >= 400 || (r.json && r.json.data && r.json.data.valid === false), `${r.status} ${(r.text || '').slice(0, 120)}`);
  }
  const vd = await call('POST', '/backup/validate-destination', { destinationPath: dest });
  s.check('BK-09', 'validate-destination for the QA folder is valid', vd.json && vd.json.data && vd.json.data.valid === true, `${vd.status} ${(vd.text || '').slice(0, 120)}`);

  for (const [id, t, b] of [['BK-10', 'compression level 99', { destinationPath: dest, compressionLevel: 99 }], ['BK-11', 'no schema and no data', { destinationPath: dest, includeSchema: false, includeData: false }], ['BK-12', 'a traversal in customName', { destinationPath: dest, customName: '..\\..\\evil' }], ['BK-13', 'missing destination', {}]]) {
    const beforeSet = new Set(fs.readdirSync(dest)); const before = beforeSet.size;
    const r = await call('POST', '/backup/create', b);
    const created = fs.readdirSync(dest).length - before;
    const outside = fs.existsSync('F:\\company\\evil.sql') || fs.existsSync('F:\\evil.sql');
    s.check(id, `Create backup with ${t}: refused (4xx), nothing written outside the destination`, (r.status >= 400 && r.status < 500 || (r.json && r.json.data && r.json.data.success === false) || (r.json && r.json.success === false)) && !outside, `${r.status} created=${created} ${(r.text || '').slice(0, 130)}`);
    fs.readdirSync(dest).filter(f => !beforeSet.has(f)).forEach(f => fs.unlinkSync(path.join(dest, f))); // only files this very call created
  }

  const t0 = Date.now();
  const cr = await call('POST', '/backup/create', { destinationPath: dest, customName: 'qa_backup_test' });
  const secs = (Date.now() - t0) / 1000;
  const res = (cr.json && cr.json.data) || {};
  s.check('BK-15', `Create backup into the QA folder succeeds (${secs.toFixed(0)} s)`, cr.status < 300 && cr.status > 0 && res.success !== false, `${cr.status} ${(cr.text || '').slice(0, 200)}`);
  const files = fs.readdirSync(dest).filter(f => /qa_backup_test/.test(f));
  const sqlFile = files.find(f => !f.endsWith('.meta'));
  const size = sqlFile ? fs.statSync(path.join(dest, sqlFile)).size : 0;
  s.check('BK-16', 'Backup file exists and is not empty (> 10 MB)', size > 10 * 1024 * 1024, `${sqlFile} ${size} bytes; files ${files.join(',')}`);
  if (sqlFile) {
    s.check('BK-17', 'Backup is an encrypted .sql.safe file, so its content cannot be inspected; it must pass the admin verify endpoint', false, 'verify endpoint reports "corrupted or invalid" for .sql.safe (ES-backup-verify); plain .sql dumps verify as valid');
  }
  const meta = files.find(f => f.endsWith('.meta'));
  console.log('INFO meta file', meta, meta ? fs.readFileSync(path.join(dest, meta), 'utf8').slice(0, 200) : '');
  const lst2 = await call('GET', `/backup/list?backupPath=${encodeURIComponent(dest)}`);
  s.check('BK-22', 'The new backup appears in the list for the QA folder', JSON.stringify(lst2.json || '').includes('qa_backup_test'), `${lst2.status} ${(lst2.text || '').slice(0, 160)}`);
  // remove only the files this suite created
  files.forEach(f => { try { fs.unlinkSync(path.join(dest, f)); } catch { } });
  try { fs.rmdirSync(dest); } catch { }

  process.exit(s.finish() ? 1 : 0);
})();
