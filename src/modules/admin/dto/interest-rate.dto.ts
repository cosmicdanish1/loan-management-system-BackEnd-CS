import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import {
  InterestRateType,
  InterestCalculationMethod,
} from '../entities/interest-rate.entity';

export class CreateInterestRateDto {
  @ApiProperty({
    description: 'Interest rate name',
    example: 'Personal Loan Rate',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Interest rate description',
    example: 'Standard interest rate for personal loans',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Type of interest rate',
    enum: InterestRateType,
    example: InterestRateType.LOAN,
  })
  @IsEnum(InterestRateType)
  type: InterestRateType;

  @ApiProperty({
    description: 'Interest rate percentage',
    example: 12.5,
    minimum: 0,
    maximum: 100,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rate: number;

  @ApiProperty({
    description: 'Interest calculation method',
    enum: InterestCalculationMethod,
    example: InterestCalculationMethod.REDUCING_BALANCE,
    default: InterestCalculationMethod.SIMPLE,
  })
  @IsEnum(InterestCalculationMethod)
  @IsOptional()
  calculationMethod?: InterestCalculationMethod = InterestCalculationMethod.SIMPLE;

  @ApiProperty({
    description: 'Minimum amount for this rate',
    example: 10000,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minAmount?: number;

  @ApiProperty({
    description: 'Maximum amount for this rate',
    example: 1000000,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  maxAmount?: number;

  @ApiProperty({
    description: 'Minimum tenure in days',
    example: 30,
    required: false,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  minTenure?: number;

  @ApiProperty({
    description: 'Maximum tenure in days',
    example: 3650,
    required: false,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  maxTenure?: number;

  @ApiProperty({
    description: 'Whether the rate is active',
    example: true,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;

  @ApiProperty({
    description: 'Effective from date',
    example: '2024-01-01',
  })
  @IsDateString()
  effectiveFrom: string;

  @ApiProperty({
    description: 'Effective to date',
    example: '2024-12-31',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  effectiveTo?: string;
}

export class UpdateInterestRateDto {
  @ApiProperty({
    description: 'Interest rate name',
    example: 'Personal Loan Rate',
    required: false,
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Interest rate description',
    example: 'Standard interest rate for personal loans',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Interest rate percentage',
    example: 12.5,
    minimum: 0,
    maximum: 100,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  rate?: number;

  @ApiProperty({
    description: 'Interest calculation method',
    enum: InterestCalculationMethod,
    example: InterestCalculationMethod.REDUCING_BALANCE,
    required: false,
  })
  @IsEnum(InterestCalculationMethod)
  @IsOptional()
  calculationMethod?: InterestCalculationMethod;

  @ApiProperty({
    description: 'Minimum amount for this rate',
    example: 10000,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minAmount?: number;

  @ApiProperty({
    description: 'Maximum amount for this rate',
    example: 1000000,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  maxAmount?: number;

  @ApiProperty({
    description: 'Minimum tenure in days',
    example: 30,
    required: false,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  minTenure?: number;

  @ApiProperty({
    description: 'Maximum tenure in days',
    example: 3650,
    required: false,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  maxTenure?: number;

  @ApiProperty({
    description: 'Whether the rate is active',
    example: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({
    description: 'Effective from date',
    example: '2024-01-01',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  effectiveFrom?: string;

  @ApiProperty({
    description: 'Effective to date',
    example: '2024-12-31',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  effectiveTo?: string;
}

export class InterestRateResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;

  @ApiProperty()
  description?: string;

  @ApiProperty({ enum: InterestRateType })
  type: InterestRateType;

  @ApiProperty()
  rate: number;

  @ApiProperty({ enum: InterestCalculationMethod })
  calculationMethod: InterestCalculationMethod;

  @ApiProperty()
  minAmount?: number;

  @ApiProperty()
  maxAmount?: number;

  @ApiProperty()
  minTenure?: number;

  @ApiProperty()
  maxTenure?: number;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  effectiveFrom: Date;

  @ApiProperty()
  effectiveTo?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
