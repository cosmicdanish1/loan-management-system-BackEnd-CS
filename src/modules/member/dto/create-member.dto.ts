import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsEmail,
  IsOptional,
  Length,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsValidAadhar, IsValidPAN, IsValidPhoneNumber, IsValidAge } from '../decorators/member-validation.decorator';

export class CreateMemberDto {
  @ApiProperty({
    description: 'First name of the member',
    example: 'John',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 50)
  firstName: string;

  @ApiProperty({
    description: 'Last name of the member',
    example: 'Doe',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 50)
  lastName: string;

  @ApiProperty({
    description: 'Date of birth in YYYY-MM-DD format',
    example: '1990-01-15',
  })
  @IsDateString()
  @IsValidAge()
  dateOfBirth: string;

  @ApiProperty({
    description: 'Complete address of the member',
    example: '123 Main Street, City, State - 123456',
  })
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiProperty({
    description: 'Phone number of the member',
    example: '+919876543210',
    maxLength: 15,
  })
  @IsString()
  @IsNotEmpty()
  @IsValidPhoneNumber()
  phoneNumber: string;

  @ApiPropertyOptional({
    description: 'Email address of the member',
    example: 'john.doe@example.com',
    maxLength: 100,
  })
  @IsOptional()
  @IsEmail()
  @Length(1, 100)
  email?: string;

  @ApiPropertyOptional({
    description: 'Aadhar number (12 digits)',
    example: '123456789012',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @IsValidAadhar()
  aadharNumber?: string;

  @ApiPropertyOptional({
    description: 'PAN number (10 characters)',
    example: 'ABCDE1234F',
    maxLength: 10,
  })
  @IsOptional()
  @IsString()
  @IsValidPAN()
  panNumber?: string;

  @ApiPropertyOptional({
    description: 'Occupation of the member',
    example: 'Software Engineer',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  occupation?: string;

  @ApiPropertyOptional({
    description: 'Share amount contributed by the member',
    example: 1000.00,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  shareAmount?: number;
}
