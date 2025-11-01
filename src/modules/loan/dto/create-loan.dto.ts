import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsString,
  IsDateString,
  IsOptional,
  IsPositive,
  Min,
  Max,
  Length,
} from 'class-validator';

export class CreateLoanDto {
  @ApiProperty({
    description: 'Member ID who is applying for the loan',
    example: 1,
  })
  @IsNumber()
  @IsNotEmpty()
  memberId: number;

  @ApiProperty({
    description: 'Principal loan amount',
    example: 100000,
    minimum: 1000,
  })
  @IsNumber()
  @IsPositive()
  @Min(1000)
  principalAmount: number;

  @ApiProperty({
    description: 'Annual interest rate in percentage',
    example: 12.5,
    minimum: 0.1,
    maximum: 50,
  })
  @IsNumber()
  @IsPositive()
  @Min(0.1)
  @Max(50)
  interestRate: number;

  @ApiProperty({
    description: 'Type of loan',
    example: 'PERSONAL',
    enum: ['PERSONAL', 'BUSINESS', 'EDUCATION', 'VEHICLE', 'HOME', 'GOLD'],
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 50)
  loanType: string;

  @ApiProperty({
    description: 'Loan disbursement date',
    example: '2024-01-15',
  })
  @IsDateString()
  disbursementDate: string;

  @ApiProperty({
    description: 'Loan maturity date',
    example: '2025-01-15',
  })
  @IsDateString()
  maturityDate: string;

  @ApiProperty({
    description: 'Loan tenure in months',
    example: 12,
    minimum: 1,
    maximum: 360,
  })
  @IsNumber()
  @Min(1)
  @Max(360)
  tenureMonths: number;

  @ApiProperty({
    description: 'Purpose of the loan',
    example: 'Business expansion',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  purpose?: string;

  @ApiProperty({
    description: 'Name of the surety/guarantor',
    example: 'John Doe',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  suretyName?: string;

  @ApiProperty({
    description: 'Phone number of the surety',
    example: '9876543210',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Length(10, 15)
  suretyPhone?: string;

  @ApiProperty({
    description: 'Address of the surety',
    example: '123 Main Street, City',
    required: false,
  })
  @IsOptional()
  @IsString()
  suretyAddress?: string;
}
