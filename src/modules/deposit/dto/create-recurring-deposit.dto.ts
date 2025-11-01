import { IsNumber, IsPositive, IsDateString, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateRecurringDepositDto {
  @ApiProperty({ description: 'Member ID who owns the deposit' })
  @IsNumber()
  @IsPositive()
  memberId: number;

  @ApiProperty({ description: 'Monthly installment amount', example: 5000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  monthlyInstallment: number;

  @ApiProperty({ description: 'Annual interest rate in percentage', example: 9.0 })
  @IsNumber()
  @IsPositive()
  @Min(0.1)
  @Max(50)
  @Type(() => Number)
  interestRate: number;

  @ApiProperty({ description: 'RD start date', example: '2024-01-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'Tenure in months', example: 24 })
  @IsNumber()
  @IsPositive()
  @Min(6)
  @Max(120)
  tenureMonths: number;
}
