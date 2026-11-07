import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';

const mockExecAsync = jest.fn();
jest.mock('child_process', () => {
  const u = require('util');
  const exec: any = jest.fn();
  exec[u.promisify.custom] = (...a: any[]) => mockExecAsync(...a);
  return { exec };
});

import { BackupService } from '../../../src/modules/admin/services/backup.service';
import { BackupController } from '../../../src/modules/admin/controllers/backup.controller';

const CLEAN = '-- PostgreSQL database dump\nDROP TABLE IF EXISTS public.ledger;\nCREATE TABLE public.ledger (a int);\n';
const PLAIN = '-- PostgreSQL database dump\nCREATE TABLE public.ledger (a int);\n';

describe('admin BackupService safety (ES-374, ES-426, ES-303)', () => {
  let dir: string; let svc: BackupService;
  const cfg = () => ({ get: (k: string, d?: any) => ({ BACKUP_DIR: dir, DB_HOST: 'localhost', DB_PORT: 5432, DB_USERNAME: 'postgres', DB_PASSWORD: 'pw', DB_DATABASE: 'society' } as any)[k] ?? d }) as any;
  const file = (name: string, body = CLEAN) => { fs.writeFileSync(path.join(dir, name), body); return path.join(dir, name); };
  /** psql check for existing data answers t / f; every other command succeeds */
  const dbHasData = (has: boolean) => mockExecAsync.mockImplementation(async (cmd: string) => (/-tA -c/.test(cmd) ? { stdout: has ? 't\n' : 'f\n' } : {}));

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bks-')); mockExecAsync.mockReset(); mockExecAsync.mockResolvedValue({}); svc = new BackupService(cfg()); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('file names', () => {
    const bad = ['../x.sql', '..\\x.sql', '/etc/passwd', 'C:\\x.sql', 'sub/x.sql', 'sub\\x.sql', 'a..b.sql', 'x.txt', 'x.sql.exe', '.sql', ' x.sql', 'x .sql', 'x;rm.sql', 'x$(id).sql', '', 'a'.repeat(200) + '.sql'];
    it('delete refuses every odd name with a 400 and touches nothing', async () => {
      const keep = file('keep.sql');
      for (const n of bad) await expect(svc.deleteBackup(n)).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.existsSync(keep)).toBe(true);
    });
    it('restore refuses every odd name and never runs psql', async () => {
      for (const n of bad) expect((await svc.restoreDatabase(n)).success).toBe(false);
      expect(mockExecAsync).not.toHaveBeenCalled();
    });
    it('verify by name refuses odd names and works for a good one', async () => {
      for (const n of bad) await expect(svc.verifyBackupByName(n)).rejects.toBeInstanceOf(BadRequestException);
      file('ok.sql');
      expect(await svc.verifyBackupByName('ok.sql')).toBe(true);
      expect(await svc.verifyBackupByName('missing.sql')).toBe(false);
    });
    it('non-string names are refused', async () => {
      for (const n of [undefined, null, 5, {}, ['a.sql']]) await expect(svc.deleteBackup(n as any)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('ordinary names like auto_2026-10-30T02-00-00-000Z.sql and dayend_2026-10-30_x.sql are fine', async () => {
      for (const n of ['auto_2026-10-30T02-00-00-000Z.sql', 'dayend_2026-10-30_2026-11-01T01-02-03-004Z.sql', 'backup_1.sql']) {
        file(n);
        await expect(svc.deleteBackup(n)).resolves.toEqual({ message: 'Backup deleted successfully' });
      }
    });
  });

  describe('delete answers', () => {
    it('a missing file is a 404, not a 400', async () => {
      await expect(svc.deleteBackup('none.sql')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('a real failure (cannot delete) is still a 400 "Failed to delete backup"', async () => {
      file('x.sql');
      jest.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(new Error('EPERM'));
      await expect(svc.deleteBackup('x.sql')).rejects.toThrow(/Failed to delete backup: EPERM/);
      jest.restoreAllMocks();
    });
  });

  describe('backup name', () => {
    const run = async (name?: string) => svc.createDatabaseBackup(name);
    it('a name with quotes, spaces, slashes, dots or shell characters is refused before pg_dump runs', async () => {
      for (const n of ['a"b', 'a b', '../x', 'a/b', 'a.b', 'a;b', 'a&&calc', '$(id)', '', 'x'.repeat(61)]) await expect(run(n)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockExecAsync).not.toHaveBeenCalled();
    });
    it('letters, digits, - and _ are fine; no name uses the default', async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => { fs.writeFileSync(/-f "([^"]+)"/.exec(cmd)![1], 'x'); return {}; });
      expect((await run('Daily_01-A')).filename).toMatch(/^Daily_01-A_/);
      expect((await run()).filename).toMatch(/^backup_/);
    });
  });

  describe('dump and restore commands (ES-374)', () => {
    it('pg_dump is run with --clean --if-exists', async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => { fs.writeFileSync(/-f "([^"]+)"/.exec(cmd)![1], CLEAN); return {}; });
      await svc.createDatabaseBackup('m');
      expect(mockExecAsync.mock.calls[0][0]).toMatch(/--clean --if-exists/);
    });
    it('psql restore stops at the first error and runs in one transaction', async () => {
      file('c.sql'); dbHasData(true);
      await svc.restoreDatabase('c.sql');
      const restore = mockExecAsync.mock.calls.map((c: any) => c[0]).find((c: string) => /-f "/.test(c));
      expect(restore).toMatch(/-v ON_ERROR_STOP=1/);
      expect(restore).toMatch(/--single-transaction/);
    });
    it('a clean backup is restored over a database that has data', async () => {
      file('c.sql', CLEAN); dbHasData(true);
      expect((await svc.restoreDatabase('c.sql')).success).toBe(true);
    });
    it('a backup made without --clean is REFUSED over a database that has data (it would double every table), and psql does not restore', async () => {
      file('old.sql', PLAIN); dbHasData(true);
      const r = await svc.restoreDatabase('old.sql');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/duplicate every record/);
      expect(mockExecAsync.mock.calls.some((c: any) => /-f "/.test(c[0]))).toBe(false);
    });
    it('...but it can still be restored into an empty database (new machine / disaster recovery)', async () => {
      file('old.sql', PLAIN); dbHasData(false);
      expect((await svc.restoreDatabase('old.sql')).success).toBe(true);
    });
    it('a psql failure (any SQL error) is reported as a failed restore', async () => {
      file('c.sql'); mockExecAsync.mockImplementation(async (cmd: string) => { if (/-f "/.test(cmd)) throw new Error('ERROR: relation exists'); return { stdout: 't' }; });
      const r = await svc.restoreDatabase('c.sql');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/Restore failed/);
    });
    it('the DROP lines only count at the start of a line (a comment or data row that mentions DROP TABLE does not make a plain dump "clean")', async () => {
      file('old.sql', PLAIN + "COPY x FROM stdin;\n-- DROP TABLE IF EXISTS fake\nINSERT INTO t VALUES ('DROP TABLE IF EXISTS y');\n"); dbHasData(true);
      expect((await svc.restoreDatabase('old.sql')).success).toBe(false);
    });
    it('the password is passed in the environment for the data check too, never on the command line', async () => {
      file('c.sql', PLAIN); dbHasData(false);
      await svc.restoreDatabase('c.sql');
      for (const [cmd, opts] of mockExecAsync.mock.calls) { expect(cmd).not.toContain('pw'); expect(opts.env.PGPASSWORD).toBe('pw'); }
    });
  });

  describe('controller', () => {
    it('verify goes through the service by name (no ./backups/ path built from the request)', async () => {
      const service: any = { verifyBackupByName: jest.fn().mockResolvedValue(true) };
      const r = await new BackupController(service).verifyBackup('a.sql');
      expect(service.verifyBackupByName).toHaveBeenCalledWith('a.sql');
      expect(r).toMatchObject({ filename: 'a.sql', isValid: true });
    });
  });
});
