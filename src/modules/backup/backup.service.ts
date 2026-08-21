import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BackupLog } from './entities/backup-log.entity';
import { loadDbConfig } from '../../config/db-config.loader';

const execAsync = promisify(exec);

export interface BackupOptions {
  destinationPath: string;
  includeSchema?: boolean;
  includeData?: boolean;
  compressionLevel?: number;
  customName?: string;
}

export interface BackupResult {
  success: boolean;
  message: string;
  filePath?: string;
  fileSize?: number;
  duration?: number;
  timestamp?: string;
}

export interface BackupInfo {
  fileName: string;
  filePath: string;
  fileSize: number;
  createdAt: string;
  type: 'full' | 'schema' | 'data';
}

export interface RestoreOptions {
  /** Backup file name (looked up in backup_log / BACKUP_PATH). */
  fileName?: string;
  /** Explicit absolute path to a backup file. Overrides fileName. */
  filePath?: string;
  /**
   * Safety confirmation. Must equal the exact target database name — a guard so
   * a restore (which overwrites the whole database) can never fire accidentally.
   */
  confirm: string;
  /** Skip the automatic pre-restore safety backup of the current database. */
  skipSafetyBackup?: boolean;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  restoredFrom?: string;
  /** Path of the safety backup taken before overwriting (if any). */
  safetyBackupPath?: string;
  duration?: number;
  timestamp?: string;
}

@Injectable()
export class BackupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(BackupLog)
    private backupLogRepository: Repository<BackupLog>,
  ) { }

  /**
   * Sync filesystem backups with database on startup
   */
  async onApplicationBootstrap() {
    await this.ensureTableExists();
    await this.syncBackupsWithDatabase();
  }

  /**
   * Ensure the backup_log table exists in the database
   */
  private async ensureTableExists() {
    try {
      await this.backupLogRepository.query(`
        CREATE TABLE IF NOT EXISTS backup_log (
          id SERIAL PRIMARY KEY,
          file_name VARCHAR(255) NOT NULL,
          file_path VARCHAR(255) NOT NULL,
          file_size BIGINT NOT NULL,
          backup_type VARCHAR(50) NOT NULL,
          status VARCHAR(50) NOT NULL,
          duration_ms INTEGER NOT NULL,
          error_message TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          created_by VARCHAR(255)
        );
      `);
      this.logger.debug('Verified backup_log table existence');
    } catch (error) {
      // If we can't create the table, we might be in trouble, but let's log it
      this.logger.error('Failed to ensure backup_log table exists', error.stack);
    }
  }

  /**
   * Scan filesystem and ensure all existing backups are in the database log
   */
  private async syncBackupsWithDatabase() {
    try {
      this.logger.log('Syncing database backup logs with filesystem...');
      const defaultBackupPath = this.configService.get('BACKUP_PATH', './backups');

      if (!fs.existsSync(defaultBackupPath)) {
        fs.mkdirSync(defaultBackupPath, { recursive: true });
        return;
      }

      // BUG FIX 51: this check-then-insert (findOne, then save if absent) has no
      // unique constraint on file_name and no lock — if this runs from more than
      // one backend process around the same time (confirmed how this happened
      // live: repeated dev restarts this session occasionally left an old
      // process still alive briefly alongside a new one, both hitting this same
      // startup hook), both can see "not found" and both insert, producing exact
      // duplicate rows for the same file — confirmed live in the Database Backup
      // screen's history list. An advisory lock serializes this sync across
      // concurrent processes without needing a migration to add a real
      // constraint (which would fail immediately against the duplicates that
      // already exist from this bug).
      await this.backupLogRepository.query(`SELECT pg_advisory_lock(hashtext('backup_log_sync'))`);
      try {
        const files = fs.readdirSync(defaultBackupPath);
        for (const file of files) {
          if (file.endsWith('.sql')) {
            const existing = await this.backupLogRepository.findOne({ where: { fileName: file } });
            if (!existing) {
              const filePath = path.join(defaultBackupPath, file);
              const stats = fs.statSync(filePath);

              await this.backupLogRepository.save({
                fileName: file,
                filePath,
                fileSize: stats.size.toString(),
                backupType: this.determineBackupType(file),
                status: 'success',
                durationMs: 0,
                createdAt: stats.birthtime,
              });
              this.logger.debug(`Synced legacy backup file: ${file}`);
            }
          }
        }
      } finally {
        await this.backupLogRepository.query(`SELECT pg_advisory_unlock(hashtext('backup_log_sync'))`);
      }
    } catch (error) {
      this.logger.error('Failed to sync backups with database', error.stack);
    }
  }

  /**
   * Create a PostgreSQL database backup using pg_dump
   */
  async createBackup(options: BackupOptions): Promise<BackupResult> {
    const startTime = Date.now();
    let fileName = '';
    let filePath = '';

    try {
      this.logger.debug('Starting backup creation check...');

      // Same source as the live DB connection (db-config.json, falling back
      // to .env) — backups always target whatever database the app is
      // actually using, even after db-config.json is edited independently.
      const dbConfig = loadDbConfig();

      if (!dbConfig.password || !dbConfig.database) {
        throw new Error('Database configuration (password or database name) is incomplete');
      }

      const defaultPath = this.configService.get('BACKUP_PATH', './backups');
      const resolvedDestinationPath = path.resolve(options.destinationPath || defaultPath);

      // Ensure destination directory exists
      if (!fs.existsSync(resolvedDestinationPath)) {
        this.logger.debug(`Creating destination directory: ${resolvedDestinationPath}`);
        fs.mkdirSync(resolvedDestinationPath, { recursive: true });
      }

      // Prepare file names and paths
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const customName = options.customName ? options.customName.replace(/[^a-z0-9]/gi, '_') : '';
      fileName = customName ? `${customName}_${timestamp}.sql` : `backup_${timestamp}.sql`;
      filePath = path.join(resolvedDestinationPath, fileName);

      this.logger.log(`Starting database backup: ${fileName} to ${resolvedDestinationPath}`);

      // Build pg_dump command
      const pgDumpPath = this.configService.get<string>('PG_DUMP_PATH', 'pg_dump');
      const pgDumpCommand = this.buildPgDumpCommand(pgDumpPath, dbConfig, filePath, options);

      this.logger.debug(`Executing command: ${pgDumpCommand.replace(dbConfig.password || '', '****')}`);

      // Execute pg_dump
      await execAsync(pgDumpCommand, {
        env: {
          ...process.env,
          PGPASSWORD: dbConfig.password,
        },
        timeout: 600000, // 10 minutes timeout
      });

      // Verify file was actually created
      if (!fs.existsSync(filePath)) {
        throw new Error(`pg_dump finished but file was not found at: ${filePath}`);
      }

      // ENCRYPTION STEP
      const encryptionKey = this.configService.get<string>('BACKUP_ENCRYPTION_KEY', 'default_secret_key');
      const encryptedFilePath = `${filePath}.safe`;

      this.logger.log(`Encrypting backup file with AES-256 for password protection...`);
      await this.encryptFile(filePath, encryptedFilePath, encryptionKey);

      // Remove the plain SQL file for security
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // Update filePath to the encrypted one for logging
      const finalFilePath = encryptedFilePath;
      const finalFileName = `${fileName}.safe`;

      const stats = fs.statSync(finalFilePath);
      const fileSize = stats.size;
      const duration = Date.now() - startTime;

      // Save to database log
      await this.backupLogRepository.save({
        fileName: finalFileName,
        filePath: finalFilePath,
        fileSize: fileSize.toString(),
        backupType: this.determineBackupType(fileName),
        status: 'success',
        durationMs: duration,
        createdAt: new Date(),
      });

      this.logger.log(`Encrypted backup completed successfully: ${finalFileName} (${this.formatFileSize(fileSize)})`);

      return {
        success: true,
        message: 'Backup completed and password-protected successfully',
        filePath: finalFilePath,
        fileSize,
        duration,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error.message;
      const duration = Date.now() - startTime;
      this.logger.error(`Backup failed: ${errorMessage}`, error.stack);

      // Log failure to database
      try {
        await this.backupLogRepository.save({
          fileName: fileName || 'failed_backup',
          filePath: filePath || 'N/A',
          fileSize: '0',
          backupType: 'full',
          status: 'failed',
          durationMs: duration,
          errorMessage: errorMessage,
          createdAt: new Date(),
        });
      } catch (logError) {
        this.logger.error('Failed to log backup failure to database', logError.stack);
      }

      return {
        success: false,
        message: `Backup failed: ${errorMessage}`,
        duration,
      };
    }
  }

  /**
   * Restore the database from a previously created (encrypted) backup file.
   *
   * DESTRUCTIVE: the backup is created with pg_dump --clean --if-exists, so
   * restoring DROPs and recreates the objects, overwriting current data. Guards:
   *  - `confirm` must equal the exact target database name.
   *  - a pre-restore safety backup of the current DB is taken automatically
   *    (unless skipSafetyBackup) so the operation is reversible.
   */
  async restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
    const startTime = Date.now();
    const dbConfig = loadDbConfig();

    if (!dbConfig.password || !dbConfig.database) {
      throw new Error('Database configuration (password or database name) is incomplete');
    }

    // Confirmation guard — refuse unless the caller names the exact database.
    if (!options.confirm || options.confirm !== dbConfig.database) {
      throw new Error(
        `Restore not confirmed. Set "confirm" to the exact target database name "${dbConfig.database}" to proceed. This overwrites all current data.`,
      );
    }

    // Resolve the backup file: explicit path wins, else look it up by name.
    const defaultPath = this.configService.get('BACKUP_PATH', './backups');
    let filePath = options.filePath;
    if (!filePath && options.fileName) {
      const log = await this.backupLogRepository.findOne({ where: { fileName: options.fileName } });
      filePath = log?.filePath || path.join(path.resolve(defaultPath), options.fileName);
    }
    if (!filePath) {
      throw new Error('Provide either "fileName" or "filePath" of the backup to restore.');
    }
    filePath = path.resolve(filePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Backup file not found: ${filePath}`);
    }

    this.logger.warn(`⚠️  Database RESTORE requested from ${filePath} into "${dbConfig.database}".`);

    // Take a safety backup of the current state first (so restore is reversible).
    let safetyBackupPath: string | undefined;
    if (!options.skipSafetyBackup) {
      this.logger.log('Taking pre-restore safety backup of the current database...');
      const safety = await this.createBackup({
        destinationPath: defaultPath,
        customName: 'pre_restore_safety',
      });
      if (!safety.success) {
        throw new Error(`Aborting restore — pre-restore safety backup failed: ${safety.message}`);
      }
      safetyBackupPath = safety.filePath;
      this.logger.log(`Safety backup saved: ${safetyBackupPath}`);
    }

    // Decrypt encrypted (.safe) backups to a temporary plain .sql file.
    let sqlPath = filePath;
    let tempCreated = false;
    if (filePath.endsWith('.safe')) {
      const encryptionKey = this.configService.get<string>('BACKUP_ENCRYPTION_KEY', 'default_secret_key');
      sqlPath = `${filePath.replace(/\.safe$/, '')}.restore_${Date.now()}.tmp.sql`;
      this.logger.log('Decrypting backup file for restore...');
      await this.decryptFile(filePath, sqlPath, encryptionKey);
    tempCreated = true;
    }

    try {
      const psqlPath = this.configService.get<string>('PSQL_PATH', 'psql');
      const restoreCommand = [
        `"${psqlPath}"`,
        `--host=${dbConfig.host}`,
        `--port=${dbConfig.port}`,
        `--username=${dbConfig.username}`,
        `--dbname=${dbConfig.database}`,
        '--set=ON_ERROR_STOP=on',
        '--single-transaction',
        `--file="${sqlPath}"`,
      ].join(' ');

      this.logger.log('Executing restore (psql)...');
      await execAsync(restoreCommand, {
        env: { ...process.env, PGPASSWORD: dbConfig.password },
        timeout: 600000, // 10 minutes
        maxBuffer: 1024 * 1024 * 64,
      });

      const duration = Date.now() - startTime;
      this.logger.log(`✓ Restore completed successfully in ${duration}ms.`);

      // Audit the restore (won't appear in the backup list, which filters status='success').
      try {
        const stats = fs.statSync(filePath);
        await this.backupLogRepository.save({
          fileName: path.basename(filePath),
          filePath,
          fileSize: stats.size.toString(),
          backupType: 'full',
          status: 'restored',
          durationMs: duration,
          createdAt: new Date(),
        });
      } catch (logError) {
        this.logger.error('Failed to log restore event', logError.stack);
      }

      return {
        success: true,
        message: `Database "${dbConfig.database}" restored successfully from ${path.basename(filePath)}.`,
        restoredFrom: filePath,
        safetyBackupPath,
        duration,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Restore failed: ${error.message}`, error.stack);
      return {
        success: false,
        message:
          `Restore failed: ${error.message}.` +
          (safetyBackupPath ? ` The pre-restore safety backup is at ${safetyBackupPath}.` : ''),
        restoredFrom: filePath,
        safetyBackupPath,
        duration,
      };
    } finally {
      // Always remove the decrypted temp file — it contains plaintext data.
      if (tempCreated && fs.existsSync(sqlPath)) {
        try {
          fs.unlinkSync(sqlPath);
        } catch (cleanupError) {
          this.logger.error(`Failed to remove temp restore file ${sqlPath}`, cleanupError.stack);
        }
      }
    }
  }

  /**
   * Build pg_dump command based on options
   */
  private buildPgDumpCommand(
    pgDumpPath: string,
    dbConfig: any,
    filePath: string,
    options: BackupOptions,
  ): string {
    const parts = [
      `"${pgDumpPath}"`,
      `--host=${dbConfig.host}`,
      `--port=${dbConfig.port}`,
      `--username=${dbConfig.username}`,
      '--verbose',
      '--clean',
      '--if-exists',
    ];

    // Add options based on backup type
    if (options.includeSchema === false) {
      parts.push('--data-only');
    } else if (options.includeData === false) {
      parts.push('--schema-only');
    }

    // Add database name and output file
    parts.push(`--file="${filePath}"`);
    parts.push(dbConfig.database);

    return parts.join(' ');
  }

  /**
   * Get list of existing backups (prioritizing database records)
   */
  async getBackupList(backupPath?: string): Promise<BackupInfo[]> {
    try {
      // First, let's get from DB as it's the primary source of truth now
      const logs = await this.backupLogRepository.find({
        order: { createdAt: 'DESC' },
        where: { status: 'success' }
      });

      if (logs.length > 0) {
        return logs.map(log => ({
          fileName: log.fileName,
          filePath: log.filePath,
          fileSize: parseInt(log.fileSize),
          createdAt: log.createdAt.toISOString(),
          type: log.backupType,
        }));
      }

      // Fallback to filesystem if DB is empty (though bootstrap should have synced it)
      const defaultBackupPath = this.configService.get('BACKUP_PATH', './backups');
      const searchPath = backupPath || defaultBackupPath;

      if (!fs.existsSync(searchPath)) return [];

      const files = fs.readdirSync(searchPath);
      const backups: BackupInfo[] = [];

      for (const file of files) {
        if (file.endsWith('.sql')) {
          const filePath = path.join(searchPath, file);
          const stats = fs.statSync(filePath);

          backups.push({
            fileName: file,
            filePath,
            fileSize: stats.size,
            createdAt: stats.birthtime.toISOString(),
            type: this.determineBackupType(file),
          });
        }
      }

      return backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    } catch (error) {
      this.logger.error('Failed to get backup list', error.stack);
      return [];
    }
  }

  /**
   * Validate backup destination
   */
  async validateDestination(destinationPath: string): Promise<{ valid: boolean; message: string }> {
    try {
      if (!fs.existsSync(destinationPath)) {
        try {
          fs.mkdirSync(destinationPath, { recursive: true });
        } catch (error) {
          return { valid: false, message: `Cannot create destination directory: ${error.message}` };
        }
      }

      const stats = fs.statSync(destinationPath);
      if (!stats.isDirectory()) {
        return { valid: false, message: 'Destination must be a directory' };
      }

      // Check write permissions
      const testFile = path.join(destinationPath, `.write_test_${Date.now()}`);
      try {
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
      } catch (error) {
        return { valid: false, message: 'No write permission to destination directory' };
      }

      return { valid: true, message: 'Valid destination' };
    } catch (error) {
      return { valid: false, message: error instanceof Error ? error.message : 'Validation failed' };
    }
  }

  /**
   * Test database connection
   */
  async testConnection(): Promise<{ connected: boolean; message: string }> {
    try {
      const dbConfig = loadDbConfig();

      const psqlPath = this.configService.get('PSQL_PATH', 'psql');

      // First check if psql is available
      try {
        await execAsync(`"${psqlPath}" --version`, { timeout: 5000 });
      } catch (psqlError) {
        return {
          connected: false,
          message: `PostgreSQL client tools (psql) not found at "${psqlPath}". Please install PostgreSQL client tools or configure PSQL_PATH.`,
        };
      }

      // Test actual database connection
      const command = `"${psqlPath}" --host=${dbConfig.host} --port=${dbConfig.port} --username=${dbConfig.username} --dbname=${dbConfig.database} --command="SELECT version();"`;

      await execAsync(command, {
        env: {
          ...process.env,
          PGPASSWORD: dbConfig.password,
        },
        timeout: 10000,
      });

      return { connected: true, message: 'Database connection successful' };
    } catch (error) {
      this.logger.error('Database connection test failed', error.stack);
      let errorMessage = 'Connection failed';
      if (error instanceof Error) {
        if (error.message.includes('authentication failed')) {
          errorMessage = 'Authentication failed. Check username and password.';
        } else if (error.message.includes('could not connect')) {
          errorMessage = 'Could not connect to database server. Check if PostgreSQL is running.';
        } else {
          errorMessage = error.message;
        }
      }
      return { connected: false, message: errorMessage };
    }
  }

  /**
   * Get database information
   */
  async getDatabaseInfo(): Promise<any> {
    const dbConfig = loadDbConfig();

    return {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      username: dbConfig.username,
    };
  }

  /**
   * Delete old backups based on retention policy
   */
  async cleanupOldBackups(backupPath?: string, retentionDays?: number): Promise<number> {
    try {
      const defaultBackupPath = this.configService.get('BACKUP_PATH', './backups');
      const searchPath = backupPath || defaultBackupPath;
      const retention = retentionDays || this.configService.get('BACKUP_RETENTION_DAYS', 30);

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retention);

      // Get logs to delete
      const logsToDelete = await this.backupLogRepository.createQueryBuilder('log')
        .where('log.createdAt < :cutoffDate', { cutoffDate })
        .getMany();

      let deletedCount = 0;

      for (const log of logsToDelete) {
        if (fs.existsSync(log.filePath)) {
          fs.unlinkSync(log.filePath);
          this.logger.log(`Deleted old backup file: ${log.fileName}`);
        }
        await this.backupLogRepository.remove(log);
        deletedCount++;
      }

      // Also scan filesystem for untracked files if needed
      if (fs.existsSync(searchPath)) {
        const files = fs.readdirSync(searchPath);
        for (const file of files) {
          if (file.endsWith('.sql')) {
            const filePath = path.join(searchPath, file);
            const stats = fs.statSync(filePath);
            if (stats.birthtime < cutoffDate) {
              fs.unlinkSync(filePath);
              deletedCount++;
              // Delete from DB too if it exists
              await this.backupLogRepository.delete({ fileName: file });
            }
          }
        }
      }

      return deletedCount;
    } catch (error) {
      this.logger.error('Failed to cleanup old backups', error.stack);
      return 0;
    }
  }

  private determineBackupType(fileName: string): 'full' | 'schema' | 'data' {
    if (fileName.includes('schema')) return 'schema';
    if (fileName.includes('data')) return 'data';
    return 'full';
  }

  private formatFileSize(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Encrypts a file using AES-256-CBC
   */
  private async encryptFile(inputPath: string, outputPath: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create a 32-byte key from the password using SHA-256
      const hashedKey = crypto.createHash('sha256').update(key).digest();
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', hashedKey, iv);

      const input = fs.createReadStream(inputPath);
      const output = fs.createWriteStream(outputPath);

      // Write the IV at the beginning of the file so we can decrypt it later
      output.write(iv);

      input.pipe(cipher).pipe(output);

      output.on('finish', () => resolve());
      output.on('error', (err) => reject(err));
      input.on('error', (err) => reject(err));
    });
  }

  /**
   * Decrypts a file produced by encryptFile() (AES-256-CBC).
   * The 16-byte IV is stored as the first 16 bytes of the file.
   */
  private async decryptFile(inputPath: string, outputPath: string, key: string): Promise<void> {
    const hashedKey = crypto.createHash('sha256').update(key).digest();

    // Read the IV (first 16 bytes) that encryptFile() wrote at the start.
    const iv = Buffer.alloc(16);
    const fd = fs.openSync(inputPath, 'r');
    try {
      const bytesRead = fs.readSync(fd, iv, 0, 16, 0);
      if (bytesRead < 16) {
        throw new Error('Backup file is too small or corrupted (missing IV header).');
      }
    } finally {
      fs.closeSync(fd);
    }

    return new Promise((resolve, reject) => {
      const decipher = crypto.createDecipheriv('aes-256-cbc', hashedKey, iv);
      // Skip the 16-byte IV header; decrypt the remainder.
      const input = fs.createReadStream(inputPath, { start: 16 });
      const output = fs.createWriteStream(outputPath);

      input.pipe(decipher).pipe(output);

      output.on('finish', () => resolve());
      output.on('error', (err) => reject(err));
      input.on('error', (err) => reject(err));
      decipher.on('error', (err) =>
        reject(new Error(`Decryption failed (wrong BACKUP_ENCRYPTION_KEY?): ${err.message}`)),
      );
    });
  }
}