import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsDateString,
  IsArray,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { DepositSlabType } from '../entities/deposit-slab.entity';

export class CreateDepositSlabDto {
  @ApiProperty({
    description: 'Deposit slab name',
    example: 'FD Slab 1-5 Lakhs',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Deposit slab description',
    example: 'Fixed deposit slab for amounts between 1-5 lakhs',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Type of deposit slab',
    enum: DepositSlabType,
    example: DepositSlabType.FIXED_DEPOSIT,
  })
  @IsEnum(DepositSlabType)
  type: DepositSlabType;

  @ApiProperty({
    description: 'Minimum amount for this slab',
    example: 100000,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minAmount: number;

  @ApiProperty({
    description: 'Maximum amount for this slab',
    example: 500000,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maxAmount: number;

  @ApiProperty({
    description: 'Minimum tenure in days',
    example: 365,
  })
  @IsNumber()
  @Min(1)
  minTenure: number;

  @ApiProperty({
    description: 'Maximum tenure in days',
    example: 1825,
  })
  @IsNumber()
  @Min(1)
  maxTenure: number;

  @ApiProperty({
    description: 'Interest rate percentage',
    example: 8.5,
    minimum: 0,
    maximum: 100,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  interestRate: number;

  @ApiProperty({
    description: 'Penalty rate for premature withdrawal',
    example: 1.0,
    minimum: 0,
    maximum: 100,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  penaltyRate?: number;

  @ApiProperty({
    description: 'Whether the slab is active',
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

export class BulkSaveDepositSlabsDto {
  @ApiProperty({
    description: 'Deposit slab type these rows replace',
    enum: DepositSlabType,
    example: DepositSlabType.FIXED_DEPOSIT,
  })
  @IsEnum(DepositSlabType)
  type: DepositSlabType;

  @ApiProperty({
    description: 'Full replacement set of slabs for the given type',
    type: [CreateDepositSlabDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateDepositSlabDto)
  rows: CreateDepositSlabDto[];
}

export class UpdateDepositSlabDto {
  @ApiProperty({
    description: 'Deposit slab name',
    example: 'FD Slab 1-5 Lakhs',
    required: false,
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Deposit slab description',
    example: 'Fixed deposit slab for amounts between 1-5 lakhs',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Minimum amount for this slab',
    example: 100000,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minAmount?: number;

  @ApiProperty({
    description: 'Maximum amount for this slab',
    example: 500000,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  maxAmount?: number;

  @ApiProperty({
    description: 'Minimum tenure in days',
    example: 365,
    required: false,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  minTenure?: number;

  @ApiProperty({
    description: 'Maximum tenure in days',
    example: 1825,
    required: false,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  maxTenure?: number;

  @ApiProperty({
    description: 'Interest rate percentage',
    example: 8.5,
    minimum: 0,
    maximum: 100,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  interestRate?: number;

  @ApiProperty({
    description: 'Penalty rate for premature withdrawal',
    example: 1.0,
    minimum: 0,
    maximum: 100,
    required: false,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  penaltyRate?: number;

  @ApiProperty({
    description: 'Whether the slab is active',
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

export class DepositSlabResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;

  @ApiProperty()
  description?: string;

  @ApiProperty({ enum: DepositSlabType })
  type: DepositSlabType;

  @ApiProperty()
  minAmount: number;

  @ApiProperty()
  maxAmount: number;

  @ApiProperty()
  minTenure: number;

  @ApiProperty()
  maxTenure: number;

  @ApiProperty()
  interestRate: number;

  @ApiProperty()
  penaltyRate?: number;

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
