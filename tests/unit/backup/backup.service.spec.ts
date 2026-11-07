import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as util from 'util';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// pg_dump / psql are never run: exec is replaced and its promisified form records every command.
const mockExecAsync = jest.fn();
jest.mock('child_process', () => {
  const u = require('util');
  const exec: any = jest.fn();
  exec[u.promisify.custom] = (...a: any[]) => mockExecAsync(...a);
  return { exec };
});

import { BackupService } from '../../../src/modules/admin/services/backup.service';

describe('admin BackupService (real files in a temp folder, no pg_dump)', () => {
  let dir: string; let svc: BackupService;
  const cfg = (over: any = {}) => ({ get: (k: string, d?: any) => ({ BACKUP_DIR: dir, DB_HOST: 'localhost', DB_PORT: 5432, DB_USERNAME: 'postgres', DB_PASSWORD: 'secret', DB_DATABASE: 'society', ...over })[k] ?? d }) as any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    mockExecAsync.mockReset();
    svc = new BackupService(cfg());
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sqlFile = (name: string, body = '-- PostgreSQL database dump\nCREATE TABLE t (a int);') => { fs.writeFileSync(path.join(dir, name), body); return path.join(dir, name); };

  it('creates the backup folder when it does not exist', () => {
    const nested = path.join(dir, 'a', 'b');
    new BackupService(cfg({ BACKUP_DIR: nested }));
    expect(fs.existsSync(nested)).toBe(true);
  });

  describe('createDatabaseBackup', () => {
    it('runs pg_dump with the password in the environment (not on the command line) and records size, checksum and metadata', async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => { const m = /-f "([^"]+)"/.exec(cmd); fs.writeFileSync(m![1], '-- PostgreSQL database dump\nSELECT 1;'); return {}; });
      const r = await svc.createDatabaseBackup('manual');
      const [cmd, opts] = mockExecAsync.mock.calls[0];
      expect(cmd).toContain('-U postgres');
      expect(cmd).toContain('-d society');
      expect(cmd).not.toContain('secret');
      expect(opts.env.PGPASSWORD).toBe('secret');
      expect(r.filename).toMatch(/^manual_.*\.sql$/);
      expect(r.size).toBeGreaterThan(0);
      expect(r.checksum).toBe(crypto.createHash('sha256').update(fs.readFileSync(r.path)).digest('hex'));
      expect(fs.existsSync(`${r.path}.meta`)).toBe(true);
    });

    it('uses a timestamped default name', async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => { fs.writeFileSync(/-f "([^"]+)"/.exec(cmd)![1], 'x'); return {}; });
      expect((await svc.createDatabaseBackup()).filename).toMatch(/^backup_\d{4}-\d{2}-\d{2}T.*\.sql$/);
    });

    it('a failing pg_dump becomes a 400 and leaves no metadata', async () => {
      mockExecAsync.mockRejectedValue(new Error('pg_dump: not found'));
      await expect(svc.createDatabaseBackup('x')).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.meta'))).toHaveLength(0);
    });

    it('the dump includes --clean --if-exists so a restore over existing data replaces the tables (ES-374)', async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => { fs.writeFileSync(/-f "([^"]+)"/.exec(cmd)![1], 'x'); return {}; });
      await svc.createDatabaseBackup('x');
      expect(mockExecAsync.mock.calls[0][0]).toMatch(/--clean/);
    });
  });

  describe('restoreDatabase', () => {
    it('restores a valid backup with psql and reports success', async () => {
      sqlFile('good.sql'); mockExecAsync.mockResolvedValue({});
      const r = await svc.restoreDatabase('good.sql');
      expect(r.success).toBe(true);
      expect(mockExecAsync.mock.calls[0][0]).toMatch(/^psql /);
      expect(mockExecAsync.mock.calls[0][1].env.PGPASSWORD).toBe('secret');
    });
    it('a missing backup is reported as a failed restore (success false), psql never runs', async () => {
      const r = await svc.restoreDatabase('nope.sql');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/not found/i);
      expect(mockExecAsync).not.toHaveBeenCalled();
    });
    it('a corrupted backup (checksum differs from its metadata) is refused', async () => {
      const f = sqlFile('bad.sql');
      fs.writeFileSync(`${f}.meta`, JSON.stringify({ filename: 'bad.sql', checksum: 'deadbeef', createdAt: new Date() }));
      const r = await svc.restoreDatabase('bad.sql');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/corrupted/i);
      expect(mockExecAsync).not.toHaveBeenCalled();
    });
    it('a psql failure is reported as a failed restore', async () => {
      sqlFile('good.sql'); mockExecAsync.mockRejectedValue(new Error('psql: FATAL'));
      expect((await svc.restoreDatabase('good.sql')).success).toBe(false);
    });
    it('a file name that climbs out of the backup folder is refused', async () => {
      const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.sql`);
      fs.writeFileSync(outside, '-- PostgreSQL database dump');
      mockExecAsync.mockResolvedValue({});
      const r = await svc.restoreDatabase(`..${path.sep}${path.basename(outside)}`);
      fs.unlinkSync(outside);
      expect(r.success).toBe(false);
      expect(mockExecAsync).not.toHaveBeenCalled();
    });
  });

  describe('listBackups', () => {
    it('lists only .sql files, newest first, with their validity', async () => {
      const a = sqlFile('a.sql'); sqlFile('b.sql', ''); fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
      fs.utimesSync(a, new Date('2026-01-01'), new Date('2026-01-01'));
      const l = await svc.listBackups();
      expect(l.map((x) => x.filename).sort()).toEqual(['a.sql', 'b.sql']);
      expect(l.find((x) => x.filename === 'a.sql')!.isValid).toBe(true);
      expect(l.find((x) => x.filename === 'b.sql')!.isValid).toBe(false); // empty file
    });
  });

  describe('deleteBackup', () => {
    it('removes the file and its metadata', async () => {
      const f = sqlFile('x.sql'); fs.writeFileSync(`${f}.meta`, '{}');
      await svc.deleteBackup('x.sql');
      expect(fs.existsSync(f)).toBe(false);
      expect(fs.existsSync(`${f}.meta`)).toBe(false);
    });
    it('a missing file is a 404 NotFoundException (it is wrapped into a 400 today)', async () => {
      await expect(svc.deleteBackup('none.sql')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('never deletes a file outside the backup folder', async () => {
      const outside = path.join(path.dirname(dir), `victim-${path.basename(dir)}.txt`);
      fs.writeFileSync(outside, 'keep me');
      await svc.deleteBackup(`..${path.sep}${path.basename(outside)}`).catch(() => undefined);
      const stillThere = fs.existsSync(outside);
      if (stillThere) fs.unlinkSync(outside);
      expect(stillThere).toBe(true);
    });
  });

  describe('verifyBackupIntegrity', () => {
    it('an empty file is invalid', async () => expect(await svc.verifyBackupIntegrity(sqlFile('e.sql', ''))).toBe(false));
    it('a missing file is invalid', async () => expect(await svc.verifyBackupIntegrity(path.join(dir, 'zz.sql'))).toBe(false));
    it('a file with no metadata is valid only if it looks like a dump', async () => {
      expect(await svc.verifyBackupIntegrity(sqlFile('ok.sql'))).toBe(true);
      expect(await svc.verifyBackupIntegrity(sqlFile('junk.sql', 'hello world'))).toBe(false);
    });
    it('a file matching the checksum in its metadata is valid', async () => {
      const f = sqlFile('m.sql', 'whatever');
      fs.writeFileSync(`${f}.meta`, JSON.stringify({ checksum: crypto.createHash('sha256').update('whatever').digest('hex') }));
      expect(await svc.verifyBackupIntegrity(f)).toBe(true);
    });
  });

  describe('automatic cleanup', () => {
    it('removes only auto_ backups older than the retention window', async () => {
      const old = new Date(Date.now() - 40 * 86400000);
      for (const n of ['auto_old.sql', 'manual_old.sql', 'auto_new.sql']) sqlFile(n);
      fs.writeFileSync(path.join(dir, 'auto_old.sql.meta'), JSON.stringify({ createdAt: old }));
      fs.writeFileSync(path.join(dir, 'manual_old.sql.meta'), JSON.stringify({ createdAt: old }));
      await (svc as any).cleanupOldBackups(30);
      expect(fs.existsSync(path.join(dir, 'auto_old.sql'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'manual_old.sql'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'auto_new.sql'))).toBe(true);
    });
  });
});
