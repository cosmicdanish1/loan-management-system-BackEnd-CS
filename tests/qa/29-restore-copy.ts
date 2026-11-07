// Backup RESTORE test on a SPARE COPY database (EMP_QA_RestoreCopy). Runs the real BackupService.restoreDatabase() code
// from src/modules/admin/services/backup.service.ts with a config that points at the copy. The live database is never used:
// the script aborts if the target database name is the live one. Run:  npx ts-node -T tests/qa/29-restore-copy.ts
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Client } from 'pg';
import { BackupService } from '../../src/modules/admin/services/backup.service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const LIVE = process.env.DB_DATABASE!;
const COPY = 'EMP_QA_RestoreCopy';
if (LIVE === COPY) throw new Error('refusing: live db equals copy name');
const DIR = 'F:\\company\\qa-restore-test';
const DUMP = path.join(DIR, 'live_dump.sql');
const BIN = path.dirname(process.env.PG_DUMP_PATH!.replace(/"/g, ''));

const cfg: any = { get: (k: string, d?: any) => (k === 'DB_DATABASE' ? COPY : k === 'BACKUP_DIR' ? DIR : (process.env as any)[k] ?? d) };
const svc = new BackupService(cfg);
if ((svc as any).dbConfig.database !== COPY) throw new Error('safety check failed: service is not pointed at the copy');

const results: { id: string; title: string; ok: boolean; detail: string }[] = [];
const check = (id: string, title: string, ok: boolean, detail = '') => { results.push({ id, title, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}${ok ? '' : '  -> ' + detail.slice(0, 260)}`); };
const db = async <T = any>(sql: string): Promise<T[]> => {
  const c = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: COPY });
  await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); }
};
const n = async (t: string) => Number((await db(`select count(*) c from ${t}`))[0].c);

(async () => {
  const basePath = process.env.PATH!;
  check('RS-00', 'The restore service targets the copy database, not the live one', (svc as any).dbConfig.database === COPY);

  // ---- S1: restore exactly as the app does it, with the machine PATH (psql is not on PATH here, PSQL_PATH is set in .env)
  let r = await svc.restoreDatabase('live_dump.sql');
  check('RS-01', 'Restore works with the settings of this machine (psql only reachable through PSQL_PATH)', r.success === true, `success=${r.success} ${r.message}`);

  // ---- from here put psql on PATH so the rest of the behaviour can be observed
  process.env.PATH = `${BIN};${basePath}`;

  // ---- S2: restore into a database that already holds the same data (what a restore on the live system is)
  const before = { led: await n('ledger'), mem: await n('member_master'), loan: await n('loan_master'), sb: await n('sbmaster') };
  r = await svc.restoreDatabase('live_dump.sql');
  const after = { led: await n('ledger'), mem: await n('member_master'), loan: await n('loan_master'), sb: await n('sbmaster') };
  console.log('INFO restore over populated copy ->', JSON.stringify(r).slice(0, 200), JSON.stringify({ before, after }));
  const dup = Object.keys(before).filter(k => (after as any)[k] !== (before as any)[k]);
  check('RS-02', 'Restoring over existing data does not duplicate or change row counts', dup.length === 0, `changed: ${dup.map(k => `${k} ${(before as any)[k]}->${(after as any)[k]}`).join(', ')}`);
  check('RS-03', 'A restore that hit "already exists" / duplicate-key errors must not report "restored successfully"', !(r.success && /successfully/i.test(r.message)), `reported success=${r.success} "${r.message}" although every table already existed (psql errors are ignored)`);

  // ---- S3: disaster simulation on the copy: lose data, then restore
  await db('delete from vouchers');
  await db('delete from loan_pending where loancaseno::text like \'8892%\'');
  const v0 = await n('vouchers'), lp0 = await n('loan_pending');
  r = await svc.restoreDatabase('live_dump.sql');
  const v1 = await n('vouchers'), lp1 = await n('loan_pending');
  console.log('INFO after disaster simulation + restore: vouchers', v0, '->', v1, ' loan_pending', lp0, '->', lp1, ' result', JSON.stringify(r).slice(0, 120));
  check('RS-04', 'After data loss, restoring the backup brings the lost rows back (vouchers and loan_pending)', v1 > v0 && lp1 > lp0, `vouchers ${v0}->${v1}, loan_pending ${lp0}->${lp1}; reported success=${r.success}`);

  // ---- S4: new-format backups
  const safeName = 'qa_encrypted_test.sql.safe';
  fs.writeFileSync(path.join(DIR, safeName), Buffer.concat([Buffer.from('SAFE1'), Buffer.alloc(4096, 7)]));
  r = await svc.restoreDatabase(safeName);
  check('RS-05', 'A .sql.safe backup (the format POST /backup/create writes now) can be restored by the restore function', r.success === true, `success=${r.success} ${r.message}`);
  fs.unlinkSync(path.join(DIR, safeName));

  // ---- S5: file name handling / traversal (the name comes from the API body)
  fs.writeFileSync(path.join(path.dirname(DIR), 'qa_traversal_marker.sql'), '-- PostgreSQL database dump\nCREATE TABLE qa_traversal_marker (i int);\n');
  r = await svc.restoreDatabase('..\\qa_traversal_marker.sql');
  const marker = await db(`select to_regclass('public.qa_traversal_marker') as t`);
  check('RS-06', "A file name with '..\\' cannot run a SQL file from outside the backup folder", !marker[0].t, `marker table created=${!!marker[0].t}; result ${JSON.stringify(r).slice(0, 120)}`);
  await db('drop table if exists qa_traversal_marker');
  fs.unlinkSync(path.join(path.dirname(DIR), 'qa_traversal_marker.sql'));

  // ---- S6: truncated / damaged file
  const trunc = path.join(DIR, 'qa_truncated.sql');
  const fd = fs.openSync(DUMP, 'r'); const buf = Buffer.alloc(20 * 1024 * 1024); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
  fs.writeFileSync(trunc, buf);
  const v = await svc.verifyBackupIntegrity(trunc);
  check('RS-07', 'Integrity check rejects a dump that was cut off after 20 MB (no completion marker)', v === false, `verifyBackupIntegrity returned ${v}`);
  fs.unlinkSync(trunc);

  // ---- S7: safety net
  const hasSafety = /pre.?restore|safety|backup.*before/i.test(fs.readFileSync(path.resolve(__dirname, '../../src/modules/admin/services/backup.service.ts'), 'utf8').split('async restoreDatabase')[1].split('async listBackups')[0]);
  check('RS-08', 'The restore takes a safety backup of the current database before overwriting anything', hasSafety, 'restoreDatabase() has no pre-restore backup step');

  const failed = results.filter(x => !x.ok).length;
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', '29-restore-copy.json'), JSON.stringify(results, null, 1));
  console.log(`\n29-restore-copy: ${results.length - failed}/${results.length} passed, ${failed} failed`);
  process.exit(0);
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
