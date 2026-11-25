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
  IsInt,
} from 'class-validator';
import { NewPassword } from '../../shared/utils/password-policy';
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
  @NewPassword() // ES-660: the same rule the person must follow when they change it themselves
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

  @ApiProperty({
    description: 'Whether the user is authorized to pass (verify) transactions',
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  allowPassTransactions?: boolean;

  @ApiProperty({
    description: "The window rights (menumaster ids) this user starts with; without it the level's default rights are used",
    required: false,
    type: [Number],
  })
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  menuIds?: number[];
}
