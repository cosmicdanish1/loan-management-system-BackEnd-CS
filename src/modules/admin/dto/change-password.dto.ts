import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { NewPassword } from '../../shared/utils/password-policy';

export class ChangePasswordDto {
  @ApiProperty({
    description: 'Current password',
    example: 'currentPassword123',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({
    description: 'New password',
    example: 'newSecurePassword123',
    minLength: 6,
  })
  @NewPassword() // ES-660
  newPassword: string;
}

export class AdminChangePasswordDto {
  @ApiProperty({
    description: 'New password for the user',
    example: 'newSecurePassword123',
    minLength: 8,
  })
  @NewPassword() // ES-660
  newPassword: string;
}
