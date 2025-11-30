import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsArray, IsOptional } from 'class-validator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';

export class RolePermissionsDto {
  @ApiProperty({
    description: 'User role',
    enum: UserRole,
    example: UserRole.LOAN_OFFICER,
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({
    description: 'Permissions for the role',
    enum: UserPermission,
    isArray: true,
  })
  @IsArray()
  @IsEnum(UserPermission, { each: true })
  permissions: UserPermission[];
}

export class UpdateUserRoleDto {
  @ApiProperty({
    description: 'New role for the user',
    enum: UserRole,
    example: UserRole.LOAN_OFFICER,
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({
    description: 'Custom permissions (optional, will use role defaults if not provided)',
    enum: UserPermission,
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsEnum(UserPermission, { each: true })
  @IsOptional()
  permissions?: UserPermission[];
}
