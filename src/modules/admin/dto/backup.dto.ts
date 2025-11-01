import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateBackupDto {
  @ApiProperty({
    description: 'Custom name for the backup (optional)',
    example: 'monthly_backup',
    required: false,
  })
  @IsString()
  @IsOptional()
  backupName?: string;
}

export class RestoreBackupDto {
  @ApiProperty({
    description: 'Filename of the backup to restore',
    example: 'backup_2024-01-15T10-30-00-000Z.sql',
  })
  @IsString()
  @IsNotEmpty()
  filename: string;
}

export class BackupResponseDto {
  @ApiProperty()
  filename: string;

  @ApiProperty()
  path: string;

  @ApiProperty()
  size: number;

  @ApiProperty()
  checksum: string;

  @ApiProperty()
  createdAt: Date;
}

export class BackupInfoDto {
  @ApiProperty()
  filename: string;

  @ApiProperty()
  path: string;

  @ApiProperty()
  size: number;

  @ApiProperty()
  checksum: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  isValid: boolean;
}

export class RestoreResultDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  message: string;

  @ApiProperty()
  restoredAt: Date;
}

export class BackupVerificationDto {
  @ApiProperty()
  filename: string;

  @ApiProperty()
  isValid: boolean;

  @ApiProperty()
  message: string;
}
