import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
// Removed date-fns import - using native Date methods

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
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Create a PostgreSQL database backup using pg_dump
   */
  async createBackup(options: BackupOptions): Promise<BackupResult> {
    const startTime = Date.now();
    
    try {
      // Get database configuration
      const dbConfig = {
        host: this.configService.get('DB_HOST', 'localhost'),
        port: this.configService.get('DB_PORT', 5432),
        username: this.configService.get('DB_USERNAME', 'postgres'),
        password: this.configService.get('DB_PASSWORD'),
        database: this.configService.get('DB_DATABASE'),
      };

      // Validate database configuration
      if (!dbConfig.password || !dbConfig.database) {
        throw new Error('Database configuration is incomplete');
      }

      // Check if pg_dump is available
      try {
        await execAsync('pg_dump --version', { timeout: 5000 });
      } catch (pgDumpError) {
        throw new Error('PostgreSQL client tools (pg_dump) not found. Please install PostgreSQL client tools and add them to your system PATH.');
      }

      // Ensure destination directory exists
      if (!fs.existsSync(options.destinationPath)) {
        fs.mkdirSync(options.destinationPath, { recursive: true });
      }

      // Generate backup filename
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '_').replace(/-/g, '_');
      const backupName = options.customName || `${dbConfig.database}_backup_${timestamp}`;
      const fileName = `${backupName}.sql`;
      const filePath = path.join(options.destinationPath, fileName);

      // Build pg_dump command
      const pgDumpCommand = this.buildPgDumpCommand(dbConfig, filePath, options);

      this.logger.log(`Starting database backup: ${fileName}`);
      this.logger.debug(`Command: ${pgDumpCommand.replace(dbConfig.password, '***')}`);

      // Execute pg_dump
      const { stdout, stderr } = await execAsync(pgDumpCommand, {
        env: {
          ...process.env,
          PGPASSWORD: dbConfig.password,
        },
        timeout: 300000, // 5 minutes timeout
      });

      if (stderr && !stderr.includes('NOTICE')) {
        this.logger.warn(`pg_dump warnings: ${stderr}`);
      }

      // Verify backup file was created
      if (!fs.existsSync(filePath)) {
        throw new Error('Backup file was not created');
      }

      // Get file size
      const stats = fs.statSync(filePath);
      const fileSize = stats.size;
      const duration = Date.now() - startTime;

      this.logger.log(`Backup completed successfully: ${fileName} (${this.formatFileSize(fileSize)})`);

      return {
        success: true,
        message: 'Database backup completed successfully',
        filePath,
        fileSize,
        duration,
        timestamp: new Date().toISOString(),
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      let errorMessage = 'Unknown backup error';
      
      if (error instanceof Error) {
        if (error.message.includes('pg_dump')) {
          errorMessage = 'PostgreSQL client tools not found. Please install PostgreSQL and add to PATH.';
        } else if (error.message.includes('authentication failed')) {
          errorMessage = 'Database authentication failed. Check username and password.';
        } else if (error.message.includes('could not connect')) {
          errorMessage = 'Could not connect to database server. Check if PostgreSQL is running.';
        } else {
          errorMessage = error.message;
        }
      }
      
      this.logger.error(`Backup failed: ${errorMessage}`, error.stack);

      return {
        success: false,
        message: errorMessage,
        duration,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Build pg_dump command based on options
   */
  private buildPgDumpCommand(
    dbConfig: any,
    filePath: string,
    options: BackupOptions,
  ): string {
    const parts = [
      'pg_dump',
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
   * Get list of existing backups
   */
  async getBackupList(backupPath?: string): Promise<BackupInfo[]> {
    try {
      const defaultBackupPath = this.configService.get('BACKUP_PATH', './backups');
      const searchPath = backupPath || defaultBackupPath;

      if (!fs.existsSync(searchPath)) {
        return [];
      }

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

      // Sort by creation date (newest first)
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
      // Check if path exists
      if (!fs.existsSync(destinationPath)) {
        try {
          fs.mkdirSync(destinationPath, { recursive: true });
        } catch (error) {
          return {
            valid: false,
            message: 'Cannot create destination directory',
          };
        }
      }

      // Check if it's a directory
      const stats = fs.statSync(destinationPath);
      if (!stats.isDirectory()) {
        return {
          valid: false,
          message: 'Destination must be a directory',
        };
      }

      // Check write permissions
      try {
        const testFile = path.join(destinationPath, '.write_test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
      } catch (error) {
        return {
          valid: false,
          message: 'No write permission to destination directory',
        };
      }

      return {
        valid: true,
        message: 'Valid destination',
      };

    } catch (error) {
      return {
        valid: false,
        message: error instanceof Error ? error.message : 'Validation failed',
      };
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

      // First check if psql is available
      try {
        await execAsync('psql --version', { timeout: 5000 });
      } catch (psqlError) {
        return {
          connected: false,
          message: 'PostgreSQL client tools (psql) not found. Please install PostgreSQL client tools and add them to your system PATH.',
        };
      }

      // Test actual database connection
      const command = `psql --host=${dbConfig.host} --port=${dbConfig.port} --username=${dbConfig.username} --dbname=${dbConfig.database} --command="SELECT version();"`;

      await execAsync(command, {
        env: {
          ...process.env,
          PGPASSWORD: dbConfig.password,
        },
        timeout: 10000, // 10 seconds timeout
      });

      return {
        connected: true,
        message: 'Database connection successful',
      };

    } catch (error) {
      this.logger.error('Database connection test failed', error.stack);
      
      let errorMessage = 'Connection failed';
      if (error instanceof Error) {
        if (error.message.includes('psql')) {
          errorMessage = 'PostgreSQL client tools not found. Please install PostgreSQL and add to PATH.';
        } else if (error.message.includes('authentication failed')) {
          errorMessage = 'Authentication failed. Check username and password.';
        } else if (error.message.includes('could not connect')) {
          errorMessage = 'Could not connect to database server. Check if PostgreSQL is running.';
        } else {
          errorMessage = error.message;
        }
      }
      
      return {
        connected: false,
        message: errorMessage,
      };
    }
  }

  /**
   * Get database information
   */
  async getDatabaseInfo(): Promise<any> {
    try {
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

    } catch (error) {
      this.logger.error('Failed to get database info', error.stack);
      throw error;
    }
  }

  /**
   * Delete old backups based on retention policy
   */
  async cleanupOldBackups(backupPath?: string, retentionDays?: number): Promise<number> {
    try {
      const defaultBackupPath = this.configService.get('BACKUP_PATH', './backups');
      const searchPath = backupPath || defaultBackupPath;
      const retention = retentionDays || this.configService.get('BACKUP_RETENTION_DAYS', 30);

      if (!fs.existsSync(searchPath)) {
        return 0;
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retention);

      const files = fs.readdirSync(searchPath);
      let deletedCount = 0;

      for (const file of files) {
        if (file.endsWith('.sql')) {
          const filePath = path.join(searchPath, file);
          const stats = fs.statSync(filePath);
          
          if (stats.birthtime < cutoffDate) {
            fs.unlinkSync(filePath);
            deletedCount++;
            this.logger.log(`Deleted old backup: ${file}`);
          }
        }
      }

      return deletedCount;

    } catch (error) {
      this.logger.error('Failed to cleanup old backups', error.stack);
      return 0;
    }
  }

  /**
   * Determine backup type from filename
   */
  private determineBackupType(fileName: string): 'full' | 'schema' | 'data' {
    if (fileName.includes('schema')) return 'schema';
    if (fileName.includes('data')) return 'data';
    return 'full';
  }

  /**
   * Format file size for display
   */
  private formatFileSize(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }
}