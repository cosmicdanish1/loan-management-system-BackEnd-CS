import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { BackupService, BackupOptions, BackupResult, BackupInfo } from './backup.service';

@ApiTags('Database Backup')
@Controller('backup')
@ApiBearerAuth()
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Post('create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create database backup' })
  @ApiResponse({
    status: 200,
    description: 'Backup created successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid backup options',
  })
  @ApiResponse({
    status: 500,
    description: 'Backup creation failed',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        destinationPath: {
          type: 'string',
          description: 'Destination directory path for backup',
          example: 'C:\\Backups',
        },
        includeSchema: {
          type: 'boolean',
          description: 'Include database schema in backup',
          default: true,
        },
        includeData: {
          type: 'boolean',
          description: 'Include data in backup',
          default: true,
        },
        compressionLevel: {
          type: 'number',
          description: 'Compression level (0-9)',
          default: 6,
        },
        customName: {
          type: 'string',
          description: 'Custom backup name (optional)',
        },
      },
      required: ['destinationPath'],
    },
  })
  async createBackup(@Body() options: BackupOptions): Promise<BackupResult> {
    return this.backupService.createBackup(options);
  }

  @Post('validate-destination')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate backup destination path' })
  @ApiResponse({
    status: 200,
    description: 'Destination validation result',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        destinationPath: {
          type: 'string',
          description: 'Path to validate',
          example: 'C:\\Backups',
        },
      },
      required: ['destinationPath'],
    },
  })
  async validateDestination(
    @Body() body: { destinationPath: string },
  ): Promise<{ valid: boolean; message: string }> {
    return this.backupService.validateDestination(body.destinationPath);
  }

  @Get('list')
  @ApiOperation({ summary: 'Get list of existing backups' })
  @ApiResponse({
    status: 200,
    description: 'List of backups retrieved successfully',
  })
  @ApiQuery({
    name: 'backupPath',
    required: false,
    description: 'Custom backup directory path',
  })
  async getBackupList(
    @Query('backupPath') backupPath?: string,
  ): Promise<BackupInfo[]> {
    return this.backupService.getBackupList(backupPath);
  }

  @Get('test-connection')
  @ApiOperation({ summary: 'Test database connection' })
  @ApiResponse({
    status: 200,
    description: 'Connection test result',
  })
  async testConnection(): Promise<{ connected: boolean; message: string }> {
    return this.backupService.testConnection();
  }

  @Get('database-info')
  @ApiOperation({ summary: 'Get database configuration information' })
  @ApiResponse({
    status: 200,
    description: 'Database information retrieved successfully',
  })
  async getDatabaseInfo(): Promise<any> {
    return this.backupService.getDatabaseInfo();
  }

  @Post('cleanup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clean up old backups based on retention policy' })
  @ApiResponse({
    status: 200,
    description: 'Cleanup completed successfully',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        backupPath: {
          type: 'string',
          description: 'Backup directory path (optional)',
        },
        retentionDays: {
          type: 'number',
          description: 'Number of days to retain backups (optional)',
          default: 30,
        },
      },
    },
  })
  async cleanupOldBackups(
    @Body() body: { backupPath?: string; retentionDays?: number },
  ): Promise<{ deletedCount: number; message: string }> {
    const deletedCount = await this.backupService.cleanupOldBackups(
      body.backupPath,
      body.retentionDays,
    );
    
    return {
      deletedCount,
      message: `Cleaned up ${deletedCount} old backup files`,
    };
  }
}