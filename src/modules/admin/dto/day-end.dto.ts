import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsEnum,
} from 'class-validator';
import {
  DayEndStatus,
  DayEndProcessType,
  DayEndProcessStep,
} from '../entities/day-end-process.entity';

export class InitiateDayEndDto {
  @ApiProperty({
    description: 'Date for which day-end processing should be performed',
    example: '2024-01-15',
  })
  @IsDateString()
  processDate: string;

  @ApiProperty({
    description: 'Whether to force day-end even if already completed for the date',
    example: false,
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  forceReprocess?: boolean = false;

  @ApiProperty({
    description: 'Specific process types to run (if not provided, all will run)',
    enum: DayEndProcessType,
    isArray: true,
    required: false,
  })
  @IsArray()
  @IsEnum(DayEndProcessType, { each: true })
  @IsOptional()
  processTypes?: DayEndProcessType[];

  @ApiProperty({
    description: 'Next working date (user selects — for skipping weekends/holidays)',
    example: '2024-01-16',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  nextWorkingDate?: string;
}

export class DayEndProcessResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  processDate: Date;

  @ApiProperty({ enum: DayEndStatus })
  status: DayEndStatus;

  @ApiProperty()
  startedAt: Date;

  @ApiProperty()
  completedAt?: Date;

  @ApiProperty()
  failedAt?: Date;

  @ApiProperty()
  errorMessage?: string;

  @ApiProperty()
  processResults?: any;

  @ApiProperty()
  processSteps?: DayEndProcessStep[];

  @ApiProperty()
  initiatedBy?: number;

  @ApiProperty()
  duration?: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class DayEndSummaryDto {
  @ApiProperty()
  processDate: Date;

  @ApiProperty()
  totalSteps: number;

  @ApiProperty()
  completedSteps: number;

  @ApiProperty()
  failedSteps: number;

  @ApiProperty()
  overallStatus: DayEndStatus;

  @ApiProperty()
  duration?: number;

  @ApiProperty()
  interestCalculations?: {
    loansProcessed: number;
    depositsProcessed: number;
    totalInterestPosted: number;
    rdAccountsProcessed: number;
    totalRdInterestAccrued: number;
  };

  @ApiProperty()
  backupInfo?: {
    backupSize: number;
    backupPath: string;
    backupTime: Date;
  };

  @ApiProperty()
  validationResults?: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    warnings: string[];
  };
}

export class InterestCalculationResultDto {
  @ApiProperty()
  accountId: number;

  @ApiProperty()
  accountNumber: string;

  @ApiProperty()
  memberName: string;

  @ApiProperty()
  principalAmount: number;

  @ApiProperty()
  interestRate: number;

  @ApiProperty()
  interestAmount: number;

  @ApiProperty()
  calculationDate: Date;

  @ApiProperty()
  status: string;
}
