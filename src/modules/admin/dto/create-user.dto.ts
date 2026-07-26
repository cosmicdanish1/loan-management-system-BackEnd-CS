import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsEmail,
  MinLength,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
} from 'class-validator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';

export class CreateUserDto {
  @ApiProperty({
    description: 'Unique username for the user',
    example: 'john_doe',
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    description: 'User email address',
    example: 'john.doe@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'User password',
    example: 'securePassword123',
    minLength: 6,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @ApiProperty({
    description: 'User first name',
    example: 'John',
  })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({
    description: 'User last name',
    example: 'Doe',
  })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({
    description: 'User role in the system',
    enum: UserRole,
    example: UserRole.DATA_OPERATOR,
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({
    description: 'User permissions array',
    enum: UserPermission,
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsEnum(UserPermission, { each: true })
  @IsOptional()
  permissions?: UserPermission[];

  @ApiProperty({
    description: 'Whether the user account is active',
    example: true,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;

  @ApiProperty({
    description: 'User avatar/profile photo URL',
    example: '/uploads/avatars/user-1.jpg',
    required: false,
  })
  @IsString()
  @IsOptional()
  avatar?: string;
}
