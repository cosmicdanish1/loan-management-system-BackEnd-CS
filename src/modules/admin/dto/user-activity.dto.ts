import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsDateString } from 'class-validator';

export class UserActivityDto {
  @ApiProperty({
    description: 'Activity type',
    example: 'LOGIN',
  })
  @IsString()
  @IsNotEmpty()
  activityType: string;

  @ApiProperty({
    description: 'Activity description',
    example: 'User logged in successfully',
  })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({
    description: 'IP address of the user',
    example: '192.168.1.1',
    required: false,
  })
  @IsString()
  @IsOptional()
  ipAddress?: string;

  @ApiProperty({
    description: 'User agent string',
    example: 'Mozilla/5.0...',
    required: false,
  })
  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class UserActivityResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  userId: number;

  @ApiProperty()
  activityType: string;

  @ApiProperty()
  description: string;

  @ApiProperty()
  ipAddress?: string;

  @ApiProperty()
  userAgent?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  user?: {
    id: number;
    username: string;
    firstName: string;
    lastName: string;
  };
}
