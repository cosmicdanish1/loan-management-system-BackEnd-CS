import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const YMD_MESSAGE = '$property must be a date in the form YYYY-MM-DD';

export class LoanEmiDto {
  @ApiProperty({ example: 300000 })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'Loan amount must be a number' })
  @Min(0.01, { message: 'Loan amount must be greater than 0' })
  @Max(999999999.99, { message: 'Loan amount is too large' })
  loanAmount: number;

  @ApiProperty({ example: 12, description: 'Interest rate, % per year' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'Interest rate must be a number' })
  @Min(0, { message: 'Interest rate cannot be negative' })
  @Max(36, { message: 'Interest rate can be at most 36 %' })
  annualRate: number;

  @ApiProperty({ example: 40 })
  @IsInt({ message: 'Number of installments must be a whole number' })
  @Min(1, { message: 'Number of installments must be at least 1' })
  @Max(600, { message: 'Number of installments can be at most 600' })
  installments: number;

  @ApiProperty({ example: '2026-06-15', description: 'Application date: decides Slot 1 / Slot 2' })
  @IsString()
  @Matches(YMD, { message: YMD_MESSAGE })
  applicationDate: string;

  @ApiPropertyOptional({ example: '2026-06-27', description: 'Payout date: decides the first due month (default: application date)' })
  @IsOptional()
  @IsString()
  @Matches(YMD, { message: YMD_MESSAGE })
  disbursementDate?: string;

  @ApiPropertyOptional({ enum: ['NONE', 'NEAREST', 'UP', 'DOWN'] })
  @IsOptional()
  @IsIn(['NONE', 'NEAREST', 'UP', 'DOWN'], { message: 'Rounding mode must be NONE, NEAREST, UP or DOWN' })
  roundingMode?: 'NONE' | 'NEAREST' | 'UP' | 'DOWN';

  @ApiPropertyOptional({ description: 'Closure interest carried from a previous agreement (re-agreement only)' })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'Carried interest must be a number' })
  @Min(0, { message: 'Carried interest cannot be negative' })
  @Max(999999999.99)
  carriedInterest?: number;

  @ApiPropertyOptional({ example: 15, description: 'Grace day of the month used as the due day (display only)' })
  @IsOptional()
  @IsInt({ message: 'Grace day must be a whole number' })
  @Min(0)
  @Max(31)
  graceDay?: number;
}
