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

      const dbConfig = {
        host: this.configService.get<string>('DB_HOST', 'localhost'),
        port: this.configService.get<number>('DB_PORT', 5432),
        username: this.configService.get<string>('DB_USERNAME', 'postgres'),
        password: this.configService.get<string>('DB_PASSWORD'),
        database: this.configService.get<string>('DB_DATABASE'),
      };

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
      const dbConfig = {
        host: this.configService.get('DB_HOST', 'localhost'),
        port: this.configService.get('DB_PORT', 5432),
        username: this.configService.get('DB_USERNAME', 'postgres'),
        password: this.configService.get('DB_PASSWORD'),
        database: this.configService.get('DB_DATABASE'),
      };

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
    const dbConfig = {
      host: this.configService.get('DB_HOST', 'localhost'),
      port: this.configService.get('DB_PORT', 5432),
      username: this.configService.get('DB_USERNAME', 'postgres'),
      database: this.configService.get('DB_DATABASE'),
    };

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
}