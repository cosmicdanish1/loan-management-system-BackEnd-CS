import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { BackupService } from '../services/backup.service';
import {
  CreateBackupDto,
  RestoreBackupDto,
  BackupResponseDto,
  BackupInfoDto,
  RestoreResultDto,
  BackupVerificationDto,
} from '../dto';

@ApiTags('Backup & Restore')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin/backup')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Post('create')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.PERFORM_BACKUP)
  @ApiOperation({ summary: 'Create database backup' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Backup created successfully',
    type: BackupResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Backup creation failed',
  })
  async createBackup(
    @Body() createBackupDto: CreateBackupDto,
  ): Promise<BackupResponseDto> {
    return this.backupService.createDatabaseBackup(createBackupDto.backupName);
  }

  @Post('restore')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.PERFORM_BACKUP)
  @ApiOperation({ summary: 'Restore database from backup' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Database restore completed',
    type: RestoreResultDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Backup file not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Restore failed',
  })
  async restoreBackup(
    @Body() restoreBackupDto: RestoreBackupDto,
  ): Promise<RestoreResultDto> {
    return this.backupService.restoreDatabase(restoreBackupDto.filename);
  }

  @Get('list')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.PERFORM_BACKUP)
  @ApiOperation({ summary: 'List all available backups' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Backups retrieved successfully',
    type: [BackupInfoDto],
  })
  async listBackups(): Promise<BackupInfoDto[]> {
    return this.backupService.listBackups();
  }

  @Get('verify/:filename')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.PERFORM_BACKUP)
  @ApiOperation({ summary: 'Verify backup integrity' })
  @ApiParam({ name: 'filename', type: String, description: 'Backup filename' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Backup verification completed',
    type: BackupVerificationDto,
  })
  async verifyBackup(
    @Param('filename') filename: string,
  ): Promise<BackupVerificationDto> {
    const backupPath = `./backups/${filename}`;
    const isValid = await this.backupService.verifyBackupIntegrity(backupPath);
    
    return {
      filename,
      isValid,
      message: isValid ? 'Backup is valid' : 'Backup is corrupted or invalid',
    };
  }

  @Delete(':filename')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.PERFORM_BACKUP)
  @ApiOperation({ summary: 'Delete backup file' })
  @ApiParam({ name: 'filename', type: String, description: 'Backup filename' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Backup deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Backup file not found',
  })
  async deleteBackup(
    @Param('filename') filename: string,
  ): Promise<{ message: string }> {
    return this.backupService.deleteBackup(filename);
  }
}
