import { IsString, IsNumber, IsBoolean, IsOptional, IsArray, IsEnum, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum InterestRateType {
  LOAN = 'loan',
  FIXED_DEPOSIT = 'fixed_deposit',
  RECURRING_DEPOSIT = 'recurring_deposit',
  SAVINGS = 'savings',
}

export class InterestRateUpdateDto {
  @ApiProperty({ enum: InterestRateType, description: 'Type of interest rate' })
  @IsEnum(InterestRateType)
  rateType: InterestRateType;

  @ApiProperty({ description: 'New interest rate percentage' })
  @IsNumber()
  newRate: number;

  @ApiProperty({ description: 'Effective date for the new rate' })
  @IsDateString()
  effectiveDate: string;

  @ApiProperty({ description: 'Whether to apply to existing accounts' })
  @IsBoolean()
  applyToExisting: boolean;

  @ApiPropertyOptional({ description: 'Specific account IDs to update', type: [Number] })
  @IsOptional()
  @IsArray()
  accountIds?: number[];

  @ApiPropertyOptional({ description: 'Minimum amount for rate application' })
  @IsOptional()
  @IsNumber()
  minAmount?: number;

  @ApiPropertyOptional({ description: 'Maximum amount for rate application' })
  @IsOptional()
  @IsNumber()
  maxAmount?: number;

  @ApiPropertyOptional({ description: 'Tenure for rate application' })
  @IsOptional()
  @IsNumber()
  tenure?: number;
}

export class BulkInterestRateUpdateDto {
  @ApiPropertyOptional({ description: 'Loan rates by type', type: 'object' })
  @IsOptional()
  loanRates?: { [key: string]: number };

  @ApiPropertyOptional({ description: 'Deposit rates by type', type: 'object' })
  @IsOptional()
  depositRates?: { [key: string]: number };

  @ApiProperty({ description: 'Effective date for the new rates' })
  @IsDateString()
  effectiveDate: string;

  @ApiProperty({ description: 'Whether to apply to existing accounts' })
  @IsBoolean()
  applyToExisting: boolean;
}

export class RecalculateInterestDto {
  @ApiProperty({ description: 'Account type', enum: ['loan', 'deposit'] })
  @IsString()
  accountType: 'loan' | 'deposit';

  @ApiProperty({ description: 'Account IDs to recalculate', type: [Number] })
  @IsArray()
  accountIds: number[];

  @ApiProperty({ description: 'Effective date for recalculation' })
  @IsDateString()
  effectiveDate: string;
}

export enum OrphanedRecordAction {
  DELETE = 'delete',
  REASSIGN = 'reassign',
  ARCHIVE = 'archive',
}

export class OrphanedRecordFixDto {
  @ApiProperty({ description: 'Record type', enum: ['loan', 'deposit', 'payment', 'transaction'] })
  @IsString()
  recordType: 'loan' | 'deposit' | 'payment' | 'transaction';

  @ApiProperty({ description: 'Record ID' })
  @IsNumber()
  recordId: number;

  @ApiProperty({ enum: OrphanedRecordAction, description: 'Action to take' })
  @IsEnum(OrphanedRecordAction)
  action: OrphanedRecordAction;

  @ApiPropertyOptional({ description: 'New parent ID for reassignment' })
  @IsOptional()
  @IsNumber()
  newParentId?: number;
}

export class BalanceCorrectionRequestDto {
  @ApiProperty({ description: 'Account type', enum: ['loan', 'deposit'] })
  @IsString()
  accountType: 'loan' | 'deposit';

  @ApiProperty({ description: 'Account ID' })
  @IsNumber()
  accountId: number;

  @ApiProperty({ description: 'Corrected balance amount' })
  @IsNumber()
  correctedBalance: number;

  @ApiProperty({ description: 'Reason for correction' })
  @IsString()
  reason: string;

  @ApiProperty({ description: 'Whether to create adjustment entry' })
  @IsBoolean()
  createAdjustmentEntry: boolean;
}

export class RemoveDuplicatesDto {
  @ApiProperty({ description: 'Record type', enum: ['member', 'loan', 'deposit'] })
  @IsString()
  recordType: 'member' | 'loan' | 'deposit';

  @ApiProperty({ description: 'Keep strategy', enum: ['oldest', 'newest', 'manual'] })
  @IsString()
  keepStrategy: 'oldest' | 'newest' | 'manual';

  @ApiPropertyOptional({ description: 'Manual keep IDs', type: [Number] })
  @IsOptional()
  @IsArray()
  manualKeepIds?: number[];
}

export class InterestRateUpdateResultDto {
  @ApiProperty({ description: 'Whether the update was successful' })
  success: boolean;

  @ApiProperty({ description: 'Result message' })
  message: string;

  @ApiProperty({ description: 'Number of affected accounts' })
  affectedAccounts: number;

  @ApiProperty({ description: 'Updated account IDs', type: [Number] })
  updatedAccounts: number[];

  @ApiProperty({ description: 'Error messages', type: [String] })
  errors: string[];

  @ApiProperty({ description: 'Whether rollback is available' })
  rollbackAvailable: boolean;
}

export class CorrectionResultDto {
  @ApiProperty({ description: 'Whether the correction was successful' })
  success: boolean;

  @ApiProperty({ description: 'Result message' })
  message: string;

  @ApiProperty({ description: 'Number of corrected records' })
  correctedRecords: number;

  @ApiProperty({ description: 'Error messages', type: [String] })
  errors: string[];

  @ApiProperty({ description: 'Whether rollback is available' })
  rollbackAvailable: boolean;
}

export class BulkCorrectionResultDto {
  @ApiProperty({ description: 'Total attempted corrections' })
  totalAttempted: number;

  @ApiProperty({ description: 'Total successful corrections' })
  totalCorrected: number;

  @ApiProperty({ description: 'Total failed corrections' })
  totalFailed: number;

  @ApiProperty({ description: 'Individual results', type: [CorrectionResultDto] })
  results: CorrectionResultDto[];

  @ApiProperty({ description: 'Summary message' })
  summary: string;
}

export class SystemHealthMetricsDto {
  @ApiProperty({ description: 'Database health metrics' })
  database: any;

  @ApiProperty({ description: 'Application health metrics' })
  application: any;

  @ApiProperty({ description: 'System resource metrics' })
  system: any;

  @ApiProperty({ description: 'Business health metrics' })
  business: any;

  @ApiProperty({ description: 'Overall health status' })
  overall: any;

  @ApiProperty({ description: 'Timestamp of metrics collection' })
  timestamp: Date;
}

export class HealthAlertDto {
  @ApiProperty({ description: 'Alert ID' })
  id: string;

  @ApiProperty({ description: 'Alert type', enum: ['CRITICAL', 'WARNING', 'INFO'] })
  type: 'CRITICAL' | 'WARNING' | 'INFO';

  @ApiProperty({ description: 'Component that generated the alert' })
  component: string;

  @ApiProperty({ description: 'Alert message' })
  message: string;

  @ApiProperty({ description: 'Alert timestamp' })
  timestamp: Date;

  @ApiProperty({ description: 'Whether the alert is resolved' })
  resolved: boolean;

  @ApiPropertyOptional({ description: 'Resolution timestamp' })
  resolvedAt?: Date;
}

export class PerformanceMetricsDto {
  @ApiProperty({ description: 'API endpoint' })
  endpoint: string;

  @ApiProperty({ description: 'HTTP method' })
  method: string;

  @ApiProperty({ description: 'Average response time in milliseconds' })
  averageResponseTime: number;

  @ApiProperty({ description: 'Total request count' })
  requestCount: number;

  @ApiProperty({ description: 'Error count' })
  errorCount: number;

  @ApiProperty({ description: 'Last accessed timestamp' })
  lastAccessed: Date;
}
