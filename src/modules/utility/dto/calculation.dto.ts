import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, IsOptional, IsDateString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class EMICalculationDto {
  @ApiProperty({ description: 'Principal loan amount', example: 100000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  principal: number;

  @ApiProperty({ description: 'Annual interest rate in percentage', example: 12 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  annualRate: number;

  @ApiProperty({ description: 'Loan tenure in months', example: 24 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  tenureMonths: number;
}

export class CompoundInterestDto {
  @ApiProperty({ description: 'Principal amount', example: 50000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  principal: number;

  @ApiProperty({ description: 'Annual interest rate in percentage', example: 8 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  annualRate: number;

  @ApiProperty({ description: 'Time period in years', example: 2 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  timeYears: number;

  @ApiProperty({ 
    description: 'Compounding frequency per year', 
    example: 12,
    required: false,
    default: 12
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  compoundingFrequency?: number = 12;
}

export class AmortizationScheduleDto {
  @ApiProperty({ description: 'Principal loan amount', example: 100000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  principal: number;

  @ApiProperty({ description: 'Annual interest rate in percentage', example: 12 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  annualRate: number;

  @ApiProperty({ description: 'Loan tenure in months', example: 24 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  tenureMonths: number;

  @ApiProperty({ description: 'Loan start date', example: '2024-01-01' })
  @IsDateString()
  startDate: string;
}

export class SimpleInterestDto {
  @ApiProperty({ description: 'Principal amount', example: 10000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  principal: number;

  @ApiProperty({ description: 'Interest rate in percentage', example: 10 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  rate: number;

  @ApiProperty({ description: 'Time period in years', example: 1 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  time: number;
}

export class PresentValueDto {
  @ApiProperty({ description: 'Future value amount', example: 110000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  futureValue: number;

  @ApiProperty({ description: 'Discount rate in percentage', example: 10 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  discountRate: number;

  @ApiProperty({ description: 'Number of periods', example: 1 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  periods: number;
}

export class FutureValueDto {
  @ApiProperty({ description: 'Present value amount', example: 100000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  presentValue: number;

  @ApiProperty({ description: 'Interest rate in percentage', example: 10 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  interestRate: number;

  @ApiProperty({ description: 'Number of periods', example: 1 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  periods: number;
}

export class PenaltyCalculationDto {
  @ApiProperty({ description: 'Principal amount', example: 50000 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  principal: number;

  @ApiProperty({ description: 'Penalty rate in percentage', example: 2 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  penaltyRate: number;

  @ApiProperty({ description: 'Number of days before maturity', example: 30 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  daysEarly: number;
}
