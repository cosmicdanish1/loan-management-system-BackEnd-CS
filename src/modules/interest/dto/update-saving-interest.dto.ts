import { IsDateString, IsNumber, IsOptional, IsString, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSavingInterestDto {
  @ApiProperty({
    description: 'Start date for interest calculation period',
    example: '2025-01-01',
  })
  @IsDateString()
  fromDate: string;

  @ApiProperty({
    description: 'End date for interest calculation period',
    example: '2025-03-31',
  })
  @IsDateString()
  toDate: string;

  @ApiProperty({
    description: 'Annual interest rate percentage',
    example: 4.0,
    minimum: 0,
    maximum: 50,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(50)
  interestRate: number;

  @ApiProperty({
    description: 'Account head code for savings accounts',
    example: 'A1001',
    required: false,
  })
  @IsOptional()
  @IsString()
  accountHead?: string;

  @ApiProperty({
    description: 'Voucher number for this interest run',
    example: 'INT2025001',
    required: false,
  })
  @IsOptional()
  @IsString()
  voucherNumber?: string;

  @ApiProperty({
    description: 'Narration for interest entries',
    example: 'Interest credited for Q1 2025',
    required: false,
  })
  @IsOptional()
  @IsString()
  narration?: string;

  @ApiProperty({
    description: 'Filter interest calculation to a single member (specific_member mode)',
    example: '1001',
    required: false,
  })
  @IsOptional()
  @IsString()
  memberNo?: string;
}

export class InterestCalculationResultDto {
  @ApiProperty({ description: 'Member number' })
  memberNumber: string;

  @ApiProperty({ description: 'Member name' })
  memberName: string;

  @ApiProperty({ description: 'Account number' })
  accountNumber: string;

  @ApiProperty({ description: 'Opening balance for the period' })
  openingBalance: number;

  @ApiProperty({ description: 'Total debits during the period' })
  totalDebit: number;

  @ApiProperty({ description: 'Total credits during the period' })
  totalCredit: number;

  @ApiProperty({ description: 'Average minimum daily balance' })
  averageBalance: number;

  @ApiProperty({ description: 'Calculated interest amount' })
  interestAmount: number;

  @ApiProperty({ description: 'Closing balance after interest' })
  closingBalance: number;

  @ApiProperty({ description: 'Number of days in calculation period' })
  days: number;
}

export class InterestRunSummaryDto {
  @ApiProperty({ description: 'Total number of eligible members' })
  totalMembers: number;

  @ApiProperty({ description: 'Total interest amount calculated' })
  totalInterestAmount: number;

  @ApiProperty({ description: 'Interest calculation period start date' })
  fromDate: string;

  @ApiProperty({ description: 'Interest calculation period end date' })
  toDate: string;

  @ApiProperty({ description: 'Interest rate used' })
  interestRate: number;

  @ApiProperty({ description: 'Voucher number for this run' })
  voucherNumber: string;

  @ApiProperty({ description: 'Timestamp when calculation was performed' })
  calculationDate: string;

  @ApiProperty({ description: 'Individual member calculations', type: [InterestCalculationResultDto] })
  memberCalculations: InterestCalculationResultDto[];
}

export class InterestHistoryDto {
  @ApiProperty({ description: 'Interest run ID' })
  id: number;

  @ApiProperty({ description: 'Interest type' })
  intType: string;

  @ApiProperty({ description: 'Period start date' })
  fromDate: string;

  @ApiProperty({ description: 'Period end date' })
  toDate: string;

  @ApiProperty({ description: 'Interest rate used' })
  rate: number;

  @ApiProperty({ description: 'Total amount paid in this run' })
  totalAmount: number;

  @ApiProperty({ description: 'Number of members who received interest' })
  memberCount: number;
}