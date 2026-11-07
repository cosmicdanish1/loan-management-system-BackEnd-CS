import {
  Injectable,
  BadRequestException,
  HttpException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface BackupResult {
  filename: string;
  path: string;
  size: number;
  checksum: string;
  createdAt: Date;
  /** how long pg_dump + checksum took (ES-35) */
  durationMs?: number;
}

export interface BackupInfo {
  filename: string;
  path: string;
  size: number;
  checksum: string;
  createdAt: Date;
  isValid: boolean;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  restoredAt: Date;
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly backupDir: string;
  private readonly dbConfig: any;

  constructor(private configService: ConfigService) {
    this.backupDir = this.configService.get('BACKUP_DIR', './backups');
    this.dbConfig = {
      host: this.configService.get('DB_HOST'),
      port: this.configService.get('DB_PORT'),
      username: this.configService.get('DB_USERNAME'),
      password: this.configService.get('DB_PASSWORD'),
      database: this.configService.get('DB_DATABASE'),
    };

    // Ensure backup directory exists
    this.ensureBackupDirectory();
  }

  /** Backup files are plain "something.sql" names inside the backup folder: no folders, no "..", no odd characters (ES-426). */
  private static readonly SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.sql(\.safe)?$/;

  private resolveBackupFile(filename: string): string {
    if (typeof filename !== 'string' || !BackupService.SAFE_FILE.test(filename) || filename.includes('..')) {
      throw new BadRequestException('Invalid backup file name');
    }
    const dir = path.resolve(this.backupDir);
    const full = path.resolve(dir, filename);
    if (path.dirname(full) !== dir) throw new BadRequestException('Invalid backup file name');
    return full;
  }

  /** Verifies a backup by its file name (used by the verify endpoint; the name is checked like every other). */
  async verifyBackupByName(filename: string): Promise<boolean> {
    return this.verifyBackupIntegrity(this.resolveBackupFile(filename));
  }

  async createDatabaseBackup(backupName?: string): Promise<BackupResult> {
    // The name becomes part of the file name AND of the pg_dump command line, so it is restricted to safe characters (ES-426)
    if (backupName !== undefined && backupName !== null && !/^[A-Za-z0-9_-]{1,60}$/.test(String(backupName))) {
      throw new BadRequestException('Backup name may contain only letters, digits, - and _ (up to 60 characters)');
    }
    const startedAt = Date.now();
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = backupName
        ? `${backupName}_${timestamp}.sql`
        : `backup_${timestamp}.sql`;
      const backupPath = path.join(this.backupDir, filename);

      this.logger.log(`Creating database backup: ${filename}`);

      // Create pg_dump command
      const dumpCommand = this.buildPgDumpCommand(backupPath);

      // Execute backup
      await execAsync(dumpCommand, {
        env: { ...process.env, PGPASSWORD: this.dbConfig.password }
      });

      // Verify backup file exists and get stats
      const stats = await fs.promises.stat(backupPath);

      // Calculate checksum
      const checksum = await this.calculateFileChecksum(backupPath);

      const result: BackupResult = {
        filename,
        path: backupPath,
        size: stats.size,
        checksum,
        createdAt: new Date(),
        durationMs: Date.now() - startedAt,
      };

      // Save backup metadata
      await this.saveBackupMetadata(result);

      this.logger.log(`Database backup created successfully: ${filename} (${stats.size} bytes)`);
      return result;
    } catch (error) {
      this.logger.error('Database backup failed:', error);
      throw new BadRequestException(`Backup failed: ${error.message}`);
    }
  }

  async restoreDatabase(backupFilename: string): Promise<RestoreResult> {
    try {
      const backupPath = this.resolveBackupFile(backupFilename);

      // Verify backup file exists
      if (!fs.existsSync(backupPath)) {
        throw new NotFoundException('Backup file not found');
      }

      // Verify backup integrity
      const isValid = await this.verifyBackupIntegrity(backupPath);
      if (!isValid) {
        throw new BadRequestException('Backup file is corrupted or invalid');
      }

      // A dump made without --clean only ADDS rows: restored over a database that already has data it doubles every
      // table (ES-374). Such a backup may only be restored into an empty database.
      // (.sql.safe files are encrypted and always written by the Backup screen with --clean, so they are not scanned.)
      if (!backupFilename.endsWith('.safe') && !(await this.isCleanDump(backupPath)) && (await this.databaseHasData())) {
        throw new BadRequestException(
          'This backup was made without the "clean" option and the database already has data: restoring it would duplicate every record. Make a new backup (it replaces tables when restored) or restore into an empty database.',
        );
      }

      this.logger.log(`Restoring database from backup: ${backupFilename}`);

      // ES-375: take a safety dump of the CURRENT database first, so a failed or wrong restore can be undone.
      // If the safety dump cannot be made, nothing is restored.
      const safetyName = `pre_restore_${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
      await execAsync(this.buildPgDumpCommand(path.join(this.backupDir, safetyName)), {
        env: { ...process.env, PGPASSWORD: this.dbConfig.password },
        maxBuffer: 64 * 1024 * 1024,
      });
      this.logger.log(`Safety backup of the current database written: ${safetyName}`);

      // ES-375: backups from the Database BackUp screen are encrypted (.sql.safe, AES-256-CBC, IV in the first
      // 16 bytes). Decrypt to a temporary plain file, restore from it, and always delete it afterwards.
      let restoreFrom = backupPath;
      let tempPlain: string | null = null;
      if (backupFilename.endsWith('.safe')) {
        tempPlain = path.join(os.tmpdir(), `restore_${Date.now()}.sql`);
        await this.decryptBackupFile(backupPath, tempPlain);
        restoreFrom = tempPlain;
      }

      try {
        // Create restore command
        const restoreCommand = this.buildPsqlCommand(restoreFrom);

        // Execute restore
        await execAsync(restoreCommand, {
          env: { ...process.env, PGPASSWORD: this.dbConfig.password },
          maxBuffer: 64 * 1024 * 1024,
        });
      } finally {
        if (tempPlain) await fs.promises.unlink(tempPlain).catch(() => undefined);
      }

      const result: RestoreResult = {
        success: true,
        message: 'Database restored successfully',
        restoredAt: new Date(),
      };

      this.logger.log(`Database restored successfully from: ${backupFilename}`);
      return result;
    } catch (error) {
      this.logger.error('Database restore failed:', error);
      return {
        success: false,
        message: `Restore failed: ${error.message}`,
        restoredAt: new Date(),
      };
    }
  }

  async listBackups(): Promise<BackupInfo[]> {
    try {
      const files = await fs.promises.readdir(this.backupDir);
      const backupFiles = files.filter(file => file.endsWith('.sql') || file.endsWith('.sql.safe'));

      const backups: BackupInfo[] = [];

      for (const filename of backupFiles) {
        const filePath = path.join(this.backupDir, filename);
        const stats = await fs.promises.stat(filePath);

        // Try to load metadata
        const metadata = await this.loadBackupMetadata(filename);

        // ES-263/ES-304: the list used to read and hash every backup file (tens of GB) on every call, so it never
        // answered in time. The list now only checks that the file exists and is not empty; the full checksum
        // comparison stays on the explicit Verify action (verifyBackupByName).
        const isValid = stats.size > 0;

        backups.push({
          filename,
          path: filePath,
          size: stats.size,
          checksum: metadata?.checksum || 'unknown',
          createdAt: metadata?.createdAt || stats.birthtime,
          isValid,
        });
      }

      // Sort by creation date (newest first)
      return backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch (error) {
      this.logger.error('Failed to list backups:', error);
      throw new BadRequestException(`Failed to list backups: ${error.message}`);
    }
  }

  async deleteBackup(filename: string): Promise<{ message: string }> {
    try {
      const backupPath = this.resolveBackupFile(filename);

      if (!fs.existsSync(backupPath)) {
        throw new NotFoundException('Backup file not found');
      }

      // Delete backup file
      await fs.promises.unlink(backupPath);

      // Delete metadata file if exists
      const metadataPath = path.join(this.backupDir, `${filename}.meta`);
      if (fs.existsSync(metadataPath)) {
        await fs.promises.unlink(metadataPath);
      }

      this.logger.log(`Backup deleted: ${filename}`);
      return { message: 'Backup deleted successfully' };
    } catch (error) {
      this.logger.error('Failed to delete backup:', error);
      // 404 / 400 raised above are answers for the caller, not failures to wrap (ES-303)
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(`Failed to delete backup: ${error.message}`);
    }
  }

  async verifyBackupIntegrity(backupPath: string): Promise<boolean> {
    try {
      // Check if file exists and is readable
      await fs.promises.access(backupPath, fs.constants.R_OK);

      // Check if file is not empty
      const stats = await fs.promises.stat(backupPath);
      if (stats.size === 0) {
        return false;
      }

      // Try to load metadata and verify checksum
      const filename = path.basename(backupPath);
      const metadata = await this.loadBackupMetadata(filename);

      if (metadata?.checksum) {
        const currentChecksum = await this.calculateFileChecksum(backupPath);
        return currentChecksum === metadata.checksum;
      }

      // If no metadata, just check if file is readable SQL
      const content = await fs.promises.readFile(backupPath, 'utf8');
      return content.includes('PostgreSQL database dump') || content.includes('CREATE TABLE');
    } catch (error) {
      this.logger.error('Backup integrity check failed:', error);
      return false;
    }
  }

  // Automated backup (runs daily at 2 AM)
  @Cron('0 2 * * *')
  async automaticBackup() {
    try {
      this.logger.log('Starting automatic backup');
      const result = await this.createDatabaseBackup('auto');
      this.logger.log(`Automatic backup completed: ${result.filename}`);

      // Clean up old backups (keep last 30 days)
      await this.cleanupOldBackups(30);
    } catch (error) {
      this.logger.error('Automatic backup failed:', error);
    }
  }

  private async cleanupOldBackups(retentionDays: number): Promise<void> {
    try {
      const backups = await this.listBackups();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const oldBackups = backups.filter(backup =>
        backup.createdAt < cutoffDate &&
        backup.filename.startsWith('auto_')
      );

      for (const backup of oldBackups) {
        await this.deleteBackup(backup.filename);
        this.logger.log(`Deleted old backup: ${backup.filename}`);
      }

      if (oldBackups.length > 0) {
        this.logger.log(`Cleaned up ${oldBackups.length} old backups`);
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old backups:', error);
    }
  }

  private async decryptBackupFile(inputPath: string, outputPath: string): Promise<void> {
    const key = crypto.createHash('sha256').update(process.env.BACKUP_ENCRYPTION_KEY || 'default_secret_key').digest();
    const fh = await fs.promises.open(inputPath, 'r');
    const iv = Buffer.alloc(16);
    try {
      await fh.read(iv, 0, 16, 0);
    } finally {
      await fh.close();
    }
    await new Promise<void>((resolve, reject) => {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      const input = fs.createReadStream(inputPath, { start: 16 });
      const output = fs.createWriteStream(outputPath);
      input.on('error', reject);
      decipher.on('error', (e) => reject(new BadRequestException('Cannot decrypt this backup (wrong BACKUP_ENCRYPTION_KEY or damaged file): ' + e.message)));
      output.on('error', reject);
      output.on('finish', () => resolve());
      input.pipe(decipher).pipe(output);
    });
  }

  private buildPgDumpCommand(outputPath: string): string {
    const { host, port, username, database } = this.dbConfig;
    // Use configured pg_dump path from env, fallback to system PATH
    const pgDumpPath = process.env.PG_DUMP_PATH || 'pg_dump';
    return `"${pgDumpPath}" -h ${host} -p ${port} -U ${username} -d ${database} -f "${outputPath}" --clean --if-exists --verbose --no-password`;
  }

  private buildPsqlCommand(inputPath: string): string {
    const { host, port, username, database } = this.dbConfig;

    // ON_ERROR_STOP + one transaction: the first error stops the restore and rolls everything back, so a failed restore
    // can no longer leave a half-restored (or doubled) database that still reports success (ES-374).
    // ES-375: honour PSQL_PATH (psql is often not on PATH on a Windows server), like PG_DUMP_PATH for pg_dump.
    return `"${process.env.PSQL_PATH || 'psql'}" -h ${host} -p ${port} -U ${username} -d ${database} -v ON_ERROR_STOP=1 --single-transaction -f "${inputPath}" --quiet --no-password`;
  }

  /** True when the dump contains DROP ... IF EXISTS statements (made with --clean), so restoring it replaces the tables. */
  private async isCleanDump(filePath: string): Promise<boolean> {
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return /^DROP (TABLE|VIEW|SEQUENCE|SCHEMA) IF EXISTS/m.test(buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await fh.close();
    }
  }

  /** True when the member table exists and has rows (the only reliable sign of a database in use). */
  private async databaseHasData(): Promise<boolean> {
    const { host, port, username, database } = this.dbConfig;
    const sql = "SELECT CASE WHEN to_regclass('public.member_master') IS NOT NULL AND EXISTS (SELECT 1 FROM member_master LIMIT 1) THEN 't' ELSE 'f' END";
    const out: any = await execAsync(
      `"${process.env.PSQL_PATH || 'psql'}" -h ${host} -p ${port} -U ${username} -d ${database} -tA -c "${sql}" --no-password`,
      { env: { ...process.env, PGPASSWORD: this.dbConfig.password } },
    );
    return String(out?.stdout ?? '').trim() === 't';
  }

  private async calculateFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async saveBackupMetadata(backup: BackupResult): Promise<void> {
    try {
      const metadataPath = path.join(this.backupDir, `${backup.filename}.meta`);
      const metadata = {
        filename: backup.filename,
        size: backup.size,
        checksum: backup.checksum,
        createdAt: backup.createdAt,
        durationMs: backup.durationMs ?? null,
      };

      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      this.logger.warn('Failed to save backup metadata:', error);
    }
  }

  private async loadBackupMetadata(filename: string): Promise<any> {
    try {
      const metadataPath = path.join(this.backupDir, `${filename}.meta`);

      if (!fs.existsSync(metadataPath)) {
        return null;
      }

      const content = await fs.promises.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(content);

      // Convert date string back to Date object
      if (metadata.createdAt) {
        metadata.createdAt = new Date(metadata.createdAt);
      }

      return metadata;
    } catch (error) {
      this.logger.warn('Failed to load backup metadata:', error);
      return null;
    }
  }

  private ensureBackupDirectory(): void {
    try {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        this.logger.log(`Created backup directory: ${this.backupDir}`);
      }
    } catch (error) {
      this.logger.error('Failed to create backup directory:', error);
      throw new Error(`Failed to create backup directory: ${error.message}`);
    }
  }
}
