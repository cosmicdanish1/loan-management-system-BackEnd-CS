import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsArray, IsString, IsEnum, IsOptional } from 'class-validator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';

export class UserLevelResponseDto {
  @ApiProperty()
  userlevelid: number;

  @ApiProperty()
  userlevel: string;
}

export class MenuResponseDto {
  @ApiProperty()
  menuid: number;

  @ApiProperty()
  menuname: string;

  @ApiProperty()
  menudesc: string;

  @ApiProperty()
  visibleflag: string;
}

export class UpdateDefaultRightsDto {
  @ApiProperty()
  @IsNumber()
  userlevelid: number;

  @ApiProperty({ type: [Number] })
  @IsArray()
  @IsNumber({}, { each: true })
  menuIds: number[];
}

export class RolePermissionsDto {
  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ enum: UserPermission, isArray: true })
  permissions: UserPermission[];
}

export class UpdateUserRoleDto {
  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({ enum: UserPermission, isArray: true, required: false })
  @IsArray()
  @IsEnum(UserPermission, { each: true })
  @IsOptional()
  permissions?: UserPermission[];
}
