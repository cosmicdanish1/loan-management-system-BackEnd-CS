import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BackupService } from './backup.service';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// Mock fs module
jest.mock('fs');
jest.mock('child_process');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExec = exec as jest.MockedFunction<typeof exec>;

describe('BackupService', () => {
  let service: BackupService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
    configService = module.get<ConfigService>(ConfigService);

    // Setup default config values
    mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
      const config = {
        BACKUP_DIR: './backups',
        DB_HOST: 'localhost',
        DB_PORT: 5432,
        DB_USERNAME: 'postgres',
        DB_PASSWORD: 'password',
        DB_DATABASE: 'test_db',
      };
      return config[key] || defaultValue;
    });

    // Mock fs.existsSync to return true for backup directory
    mockFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createDatabaseBackup', () => {
    it('should create database backup successfully', async () => {
      const mockStats = {
        size: 1024000,
        birthtime: new Date(),
      };

      // Mock successful command execution
      mockExec.mockImplementation((command, callback) => {
        callback(null, 'Backup completed', '');
        return {} as any;
      });

      // Mock fs operations
      mockFs.promises = {
        stat: jest.fn().mockResolvedValue(mockStats),
        writeFile: jest.fn().mockResolvedValue(undefined),
      } as any;

      // Mock file checksum calculation
      jest.spyOn(service as any, 'calculateFileChecksum').mockResolvedValue('abc123');

      const result = await service.createDatabaseBackup('test_backup');

      expect(result.filename).toContain('test_backup');
      expect(result.size).toBe(1024000);
      expect(result.checksum).toBe('abc123');
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it('should throw BadRequestException on backup failure', async () => {
      // Mock failed command execution
      mockExec.mockImplementation((command, callback) => {
        callback(new Error('Backup failed'), '', 'Error message');
        return {} as any;
      });

      await expect(service.createDatabaseBackup('test_backup')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should generate filename with timestamp when no name provided', async () => {
      const mockStats = {
        size: 1024000,
        birthtime: new Date(),
      };

      mockExec.mockImplementation((command, callback) => {
        callback(null, 'Backup completed', '');
        return {} as any;
      });

      mockFs.promises = {
        stat: jest.fn().mockResolvedValue(mockStats),
        writeFile: jest.fn().mockResolvedValue(undefined),
      } as any;

      jest.spyOn(service as any, 'calculateFileChecksum').mockResolvedValue('abc123');

      const result = await service.createDatabaseBackup();

      expect(result.filename).toMatch(/^backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });
  });

  describe('restoreDatabase', () => {
    it('should restore database successfully', async () => {
      const backupFilename = 'test_backup.sql';

      // Mock file exists
      mockFs.existsSync.mockReturnValue(true);

      // Mock backup integrity verification
      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(true);

      // Mock successful restore command
      mockExec.mockImplementation((command, callback) => {
        callback(null, 'Restore completed', '');
        return {} as any;
      });

      const result = await service.restoreDatabase(backupFilename);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Database restored successfully');
      expect(result.restoredAt).toBeInstanceOf(Date);
    });

    it('should throw NotFoundException if backup file not found', async () => {
      const backupFilename = 'nonexistent_backup.sql';

      mockFs.existsSync.mockReturnValue(false);

      await expect(service.restoreDatabase(backupFilename)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if backup is corrupted', async () => {
      const backupFilename = 'corrupted_backup.sql';

      mockFs.existsSync.mockReturnValue(true);
      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(false);

      await expect(service.restoreDatabase(backupFilename)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return failure result on restore error', async () => {
      const backupFilename = 'test_backup.sql';

      mockFs.existsSync.mockReturnValue(true);
      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(true);

      // Mock failed restore command
      mockExec.mockImplementation((command, callback) => {
        callback(new Error('Restore failed'), '', 'Error message');
        return {} as any;
      });

      const result = await service.restoreDatabase(backupFilename);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Restore failed');
    });
  });

  describe('listBackups', () => {
    it('should list all backup files', async () => {
      const mockFiles = ['backup1.sql', 'backup2.sql', 'other.txt'];
      const mockStats = {
        size: 1024000,
        birthtime: new Date('2024-01-15'),
      };

      mockFs.promises = {
        readdir: jest.fn().mockResolvedValue(mockFiles),
        stat: jest.fn().mockResolvedValue(mockStats),
      } as any;

      jest.spyOn(service as any, 'loadBackupMetadata').mockResolvedValue({
        checksum: 'abc123',
        createdAt: new Date('2024-01-15'),
      });

      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(true);

      const result = await service.listBackups();

      expect(result).toHaveLength(2); // Only .sql files
      expect(result[0].filename).toBe('backup1.sql');
      expect(result[0].isValid).toBe(true);
      expect(result[0].checksum).toBe('abc123');
    });

    it('should handle missing metadata gracefully', async () => {
      const mockFiles = ['backup1.sql'];
      const mockStats = {
        size: 1024000,
        birthtime: new Date('2024-01-15'),
      };

      mockFs.promises = {
        readdir: jest.fn().mockResolvedValue(mockFiles),
        stat: jest.fn().mockResolvedValue(mockStats),
      } as any;

      jest.spyOn(service as any, 'loadBackupMetadata').mockResolvedValue(null);
      jest.spyOn(service, 'verifyBackupIntegrity').mockResolvedValue(true);

      const result = await service.listBackups();

      expect(result).toHaveLength(1);
      expect(result[0].checksum).toBe('unknown');
      expect(result[0].createdAt).toEqual(mockStats.birthtime);
    });
  });

  describe('deleteBackup', () => {
    it('should delete backup file successfully', async () => {
      const filename = 'test_backup.sql';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises = {
        unlink: jest.fn().mockResolvedValue(undefined),
      } as any;

      const result = await service.deleteBackup(filename);

      expect(mockFs.promises.unlink).toHaveBeenCalledWith(
        path.join('./backups', filename),
      );
      expect(result.message).toBe('Backup deleted successfully');
    });

    it('should throw NotFoundException if backup file not found', async () => {
      const filename = 'nonexistent_backup.sql';

      mockFs.existsSync.mockReturnValue(false);

      await expect(service.deleteBackup(filename)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should delete metadata file if exists', async () => {
      const filename = 'test_backup.sql';

      mockFs.existsSync
        .mockReturnValueOnce(true) // Backup file exists
        .mockReturnValueOnce(true); // Metadata file exists

      mockFs.promises = {
        unlink: jest.fn().mockResolvedValue(undefined),
      } as any;

      await service.deleteBackup(filename);

      expect(mockFs.promises.unlink).toHaveBeenCalledTimes(2);
      expect(mockFs.promises.unlink).toHaveBeenCalledWith(
        path.join('./backups', `${filename}.meta`),
      );
    });
  });

  describe('verifyBackupIntegrity', () => {
    it('should return true for valid backup', async () => {
      const backupPath = './backups/test_backup.sql';

      mockFs.promises = {
        access: jest.fn().mockResolvedValue(undefined),
        stat: jest.fn().mockResolvedValue({ size: 1024000 }),
        readFile: jest.fn().mockResolvedValue('PostgreSQL database dump\nCREATE TABLE test;'),
      } as any;

      jest.spyOn(service as any, 'loadBackupMetadata').mockResolvedValue({
        checksum: 'abc123',
      });

      jest.spyOn(service as any, 'calculateFileChecksum').mockResolvedValue('abc123');

      const result = await service.verifyBackupIntegrity(backupPath);

      expect(result).toBe(true);
    });

    it('should return false for empty backup file', async () => {
      const backupPath = './backups/empty_backup.sql';

      mockFs.promises = {
        access: jest.fn().mockResolvedValue(undefined),
        stat: jest.fn().mockResolvedValue({ size: 0 }),
      } as any;

      const result = await service.verifyBackupIntegrity(backupPath);

      expect(result).toBe(false);
    });

    it('should return false for corrupted backup (checksum mismatch)', async () => {
      const backupPath = './backups/corrupted_backup.sql';

      mockFs.promises = {
        access: jest.fn().mockResolvedValue(undefined),
        stat: jest.fn().mockResolvedValue({ size: 1024000 }),
      } as any;

      jest.spyOn(service as any, 'loadBackupMetadata').mockResolvedValue({
        checksum: 'abc123',
      });

      jest.spyOn(service as any, 'calculateFileChecksum').mockResolvedValue('def456');

      const result = await service.verifyBackupIntegrity(backupPath);

      expect(result).toBe(false);
    });

    it('should return false on file access error', async () => {
      const backupPath = './backups/inaccessible_backup.sql';

      mockFs.promises = {
        access: jest.fn().mockRejectedValue(new Error('File not accessible')),
      } as any;

      const result = await service.verifyBackupIntegrity(backupPath);

      expect(result).toBe(false);
    });
  });

  describe('private helper methods', () => {
    describe('buildPgDumpCommand', () => {
      it('should build correct pg_dump command', () => {
        const outputPath = './backups/test.sql';
        const command = (service as any).buildPgDumpCommand(outputPath);

        expect(command).toContain('pg_dump');
        expect(command).toContain('-h localhost');
        expect(command).toContain('-p 5432');
        expect(command).toContain('-U postgres');
        expect(command).toContain('-d test_db');
        expect(command).toContain(`-f "${outputPath}"`);
        expect(command).toContain('PGPASSWORD="password"');
      });
    });

    describe('buildPsqlCommand', () => {
      it('should build correct psql command', () => {
        const inputPath = './backups/test.sql';
        const command = (service as any).buildPsqlCommand(inputPath);

        expect(command).toContain('psql');
        expect(command).toContain('-h localhost');
        expect(command).toContain('-p 5432');
        expect(command).toContain('-U postgres');
        expect(command).toContain('-d test_db');
        expect(command).toContain(`-f "${inputPath}"`);
        expect(command).toContain('PGPASSWORD="password"');
      });
    });

    describe('saveBackupMetadata', () => {
      it('should save backup metadata to file', async () => {
        const backupResult = {
          filename: 'test_backup.sql',
          size: 1024000,
          checksum: 'abc123',
          createdAt: new Date('2024-01-15'),
        };

        mockFs.promises = {
          writeFile: jest.fn().mockResolvedValue(undefined),
        } as any;

        await (service as any).saveBackupMetadata(backupResult);

        expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
          path.join('./backups', 'test_backup.sql.meta'),
          expect.stringContaining('"filename":"test_backup.sql"'),
        );
      });
    });

    describe('loadBackupMetadata', () => {
      it('should load backup metadata from file', async () => {
        const filename = 'test_backup.sql';
        const metadata = {
          filename,
          size: 1024000,
          checksum: 'abc123',
          createdAt: '2024-01-15T00:00:00.000Z',
        };

        mockFs.existsSync.mockReturnValue(true);
        mockFs.promises = {
          readFile: jest.fn().mockResolvedValue(JSON.stringify(metadata)),
        } as any;

        const result = await (service as any).loadBackupMetadata(filename);

        expect(result.filename).toBe(filename);
        expect(result.createdAt).toBeInstanceOf(Date);
      });

      it('should return null if metadata file does not exist', async () => {
        const filename = 'test_backup.sql';

        mockFs.existsSync.mockReturnValue(false);

        const result = await (service as any).loadBackupMetadata(filename);

        expect(result).toBeNull();
      });
    });
  });
});
