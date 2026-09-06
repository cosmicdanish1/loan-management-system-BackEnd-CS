import { ApiProperty } from '@nestjs/swagger';
import { UserRole, UserPermission } from '../entities/user.entity';

export class UserResponseDto {
  @ApiProperty({
    description: 'User ID',
    example: 1,
  })
  id: number;

  @ApiProperty({
    description: 'Username',
    example: 'john_doe',
  })
  username: string;

  @ApiProperty({
    description: 'User email',
    example: 'john.doe@example.com',
  })
  email: string;

  @ApiProperty({
    description: 'User first name',
    example: 'John',
  })
  firstName: string;

  @ApiProperty({
    description: 'User last name',
    example: 'Doe',
  })
  lastName: string;

  @ApiProperty({
    description: 'User full name',
    example: 'John Doe',
  })
  fullName: string;

  @ApiProperty({
    description: 'User role',
    enum: UserRole,
    example: UserRole.DATA_OPERATOR,
  })
  role: UserRole;

  @ApiProperty({
    description: 'User permissions',
    enum: UserPermission,
    isArray: true,
  })
  permissions: UserPermission[];

  @ApiProperty({
    description: 'Navbar action codes this user is allowed to see (menu-level rights from Configure UserLevel Default Rights). Null means unrestricted (SYSTEM/ADMINISTRATOR).',
    type: [String],
    nullable: true,
    required: false,
  })
  allowedActions?: string[] | null;

  @ApiProperty({
    description: 'User active status',
    example: true,
  })
  isActive: boolean;

  @ApiProperty({
    description: 'Whether the user is authorized to pass (verify) transactions',
    example: false,
    required: false,
  })
  allowPassTransactions?: boolean;

  @ApiProperty({
    description: 'User avatar/profile photo URL',
    example: '/uploads/avatars/user-1.jpg',
    required: false,
  })
  avatar?: string;

  @ApiProperty({
    description: 'Last login timestamp',
    example: '2023-10-17T10:30:00Z',
  })
  lastLoginAt: Date;

  @ApiProperty({
    description: 'User creation timestamp',
    example: '2023-10-01T09:00:00Z',
  })
  createdAt: Date;
}

export class AuthResponseDto {
  @ApiProperty({
    description: 'JWT access token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken: string;

  @ApiProperty({
    description: 'JWT refresh token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  refreshToken: string;

  @ApiProperty({
    description: 'Token type',
    example: 'Bearer',
  })
  tokenType: string;

  @ApiProperty({
    description: 'Token expiration time in seconds',
    example: 3600,
  })
  expiresIn: number;

  @ApiProperty({
    description: 'Authenticated user information',
    type: UserResponseDto,
  })
  user: UserResponseDto;
}
