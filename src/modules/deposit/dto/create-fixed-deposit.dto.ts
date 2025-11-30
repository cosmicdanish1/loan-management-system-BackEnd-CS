import { IsNumber, IsPositive, IsDateString, IsOptional, IsBoolean, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateFixedDepositDto {
  @ApiProperty({ description: 'Member ID who owns the deposit' })
  @IsNumber()
  @IsPositive()
  memberId: number;

  @ApiProperty({ description: 'Principal deposit amount', example: 100000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  principalAmount: number;

  @ApiProperty({ description: 'Annual interest rate in percentage', example: 8.5 })
  @IsNumber()
  @IsPositive()
  @Min(0.1)
  @Max(50)
  @Type(() => Number)
  interestRate: number;

  @ApiProperty({ description: 'Deposit start date', example: '2024-01-01' })
  @IsDateString()
  depositDate: string;

  @ApiProperty({ description: 'Tenure in months', example: 12 })
  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(120)
  tenureMonths: number;

  @ApiProperty({ description: 'Enable auto-renewal on maturity', required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isAutoRenewal?: boolean;
}
