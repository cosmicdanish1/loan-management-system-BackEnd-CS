import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength, IsOptional, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'Username or email for login',
    example: 'admin@example.com',
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    description: 'User password',
    example: 'password123',
    minLength: 6,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @ApiProperty({
    description: 'Trusted-device token issued by a previous "remember this device" 2FA login',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceToken?: string;
}
