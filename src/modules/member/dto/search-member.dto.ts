import { IsOptional, IsString, IsIn, IsNumber, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export class SearchMemberDto {
  @ApiPropertyOptional({
    description: 'Search by member number',
    example: 'MEM001',
  })
  @IsOptional()
  @IsString()
  memberNumber?: string;

  @ApiPropertyOptional({
    description: 'Search by first name (partial match)',
    example: 'John',
  })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({
    description: 'Search by last name (partial match)',
    example: 'Doe',
  })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({
    description: 'Search by phone number',
    example: '9876543210',
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    description: 'Search by email',
    example: 'john@example.com',
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({
    description: 'Search by Aadhar number',
    example: '123456789012',
  })
  @IsOptional()
  @IsString()
  aadharNumber?: string;

  @ApiPropertyOptional({
    description: 'Search by PAN number',
    example: 'ABCDE1234F',
  })
  @IsOptional()
  @IsString()
  panNumber?: string;

  @ApiPropertyOptional({
    description: 'Filter by status',
    example: 'ACTIVE',
    enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'])
  status?: string;

  @ApiPropertyOptional({
    description: 'General search term (searches across name, phone, email)',
    example: 'john',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    example: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 10,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Sort field',
    example: 'memberNumber',
    enum: ['memberNumber', 'firstName', 'lastName', 'createdAt', 'updatedAt'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['memberNumber', 'firstName', 'lastName', 'createdAt', 'updatedAt'])
  sortBy?: string = 'memberNumber';

  @ApiPropertyOptional({
    description: 'Sort order',
    example: 'ASC',
    enum: ['ASC', 'DESC'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'ASC';
}
