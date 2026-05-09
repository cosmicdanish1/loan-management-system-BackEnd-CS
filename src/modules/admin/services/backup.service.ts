import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface BackupResult {
  filename: string;
  path: string;
  size: number;
  checksum: string;
  createdAt: Date;
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

  async createDatabaseBackup(backupName?: string): Promise<BackupResult> {
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
      const backupPath = path.join(this.backupDir, backupFilename);

      // Verify backup file exists
      if (!fs.existsSync(backupPath)) {
        throw new NotFoundException('Backup file not found');
      }

      // Verify backup integrity
      const isValid = await this.verifyBackupIntegrity(backupPath);
      if (!isValid) {
        throw new BadRequestException('Backup file is corrupted or invalid');
      }

      this.logger.log(`Restoring database from backup: ${backupFilename}`);

      // Create restore command
      const restoreCommand = this.buildPsqlCommand(backupPath);

      // Execute restore
      await execAsync(restoreCommand, {
        env: { ...process.env, PGPASSWORD: this.dbConfig.password }
      });

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
      const backupFiles = files.filter(file => file.endsWith('.sql'));

      const backups: BackupInfo[] = [];

      for (const filename of backupFiles) {
        const filePath = path.join(this.backupDir, filename);
        const stats = await fs.promises.stat(filePath);

        // Try to load metadata
        const metadata = await this.loadBackupMetadata(filename);

        // Verify integrity
        const isValid = await this.verifyBackupIntegrity(filePath);

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
      const backupPath = path.join(this.backupDir, filename);

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

  private buildPgDumpCommand(outputPath: string): string {
    const { host, port, username, database } = this.dbConfig;
    // Use configured pg_dump path from env, fallback to system PATH
    const pgDumpPath = process.env.PG_DUMP_PATH || 'pg_dump';
    return `"${pgDumpPath}" -h ${host} -p ${port} -U ${username} -d ${database} -f "${outputPath}" --verbose --no-password`;
  }

  private buildPsqlCommand(inputPath: string): string {
    const { host, port, username, database } = this.dbConfig;

    return `psql -h ${host} -p ${port} -U ${username} -d ${database} -f "${inputPath}" --quiet --no-password`;
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
