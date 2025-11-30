import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import { ConfigCategory, ConfigDataType } from '../entities/system-config.entity';

export class CreateSystemConfigDto {
  @ApiProperty({
    description: 'Unique configuration key',
    example: 'default_loan_interest_rate',
  })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({
    description: 'Human-readable name',
    example: 'Default Loan Interest Rate',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Configuration description',
    example: 'Default interest rate applied to new loans',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Configuration value',
    example: '12.5',
  })
  @IsString()
  @IsNotEmpty()
  value: string;

  @ApiProperty({
    description: 'Data type of the configuration value',
    enum: ConfigDataType,
    example: ConfigDataType.PERCENTAGE,
  })
  @IsEnum(ConfigDataType)
  dataType: ConfigDataType;

  @ApiProperty({
    description: 'Configuration category',
    enum: ConfigCategory,
    example: ConfigCategory.INTEREST_RATES,
  })
  @IsEnum(ConfigCategory)
  category: ConfigCategory;

  @ApiProperty({
    description: 'Whether the configuration is active',
    example: true,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;

  @ApiProperty({
    description: 'Whether the configuration is read-only',
    example: false,
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isReadonly?: boolean = false;

  @ApiProperty({
    description: 'Validation rules as JSON string',
    example: '{"min": 0, "max": 100}',
    required: false,
  })
  @IsString()
  @IsOptional()
  validationRules?: string;

  @ApiProperty({
    description: 'Default value',
    example: '10.0',
    required: false,
  })
  @IsString()
  @IsOptional()
  defaultValue?: string;

  @ApiProperty({
    description: 'Unit of measurement',
    example: '%',
    required: false,
  })
  @IsString()
  @IsOptional()
  unit?: string;
}

export class UpdateSystemConfigDto {
  @ApiProperty({
    description: 'Human-readable name',
    example: 'Default Loan Interest Rate',
    required: false,
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Configuration description',
    example: 'Default interest rate applied to new loans',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Configuration value',
    example: '12.5',
    required: false,
  })
  @IsString()
  @IsOptional()
  value?: string;

  @ApiProperty({
    description: 'Data type of the configuration value',
    enum: ConfigDataType,
    example: ConfigDataType.PERCENTAGE,
    required: false,
  })
  @IsEnum(ConfigDataType)
  @IsOptional()
  dataType?: ConfigDataType;

  @ApiProperty({
    description: 'Configuration category',
    enum: ConfigCategory,
    example: ConfigCategory.INTEREST_RATES,
    required: false,
  })
  @IsEnum(ConfigCategory)
  @IsOptional()
  category?: ConfigCategory;

  @ApiProperty({
    description: 'Whether the configuration is active',
    example: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({
    description: 'Validation rules as JSON string',
    example: '{"min": 0, "max": 100}',
    required: false,
  })
  @IsString()
  @IsOptional()
  validationRules?: string;

  @ApiProperty({
    description: 'Default value',
    example: '10.0',
    required: false,
  })
  @IsString()
  @IsOptional()
  defaultValue?: string;

  @ApiProperty({
    description: 'Unit of measurement',
    example: '%',
    required: false,
  })
  @IsString()
  @IsOptional()
  unit?: string;
}

export class SystemConfigResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  key: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  description?: string;

  @ApiProperty()
  value: string;

  @ApiProperty()
  typedValue: any;

  @ApiProperty({ enum: ConfigDataType })
  dataType: ConfigDataType;

  @ApiProperty({ enum: ConfigCategory })
  category: ConfigCategory;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  isReadonly: boolean;

  @ApiProperty()
  validationRules?: string;

  @ApiProperty()
  defaultValue?: string;

  @ApiProperty()
  unit?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
