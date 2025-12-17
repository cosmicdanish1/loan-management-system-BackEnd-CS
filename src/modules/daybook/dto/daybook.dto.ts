 import { IsString, IsOptional, IsDateString, IsEnum, IsNumber } from 'class-validator';

export class GetDayBookDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @IsEnum(['screen', 'printer'])
  outputType?: 'screen' | 'printer' = 'screen';

  @IsOptional()
  @IsString()
  filterType?: 'all' | 'sb' | 'savings' = 'all';
}

export class DayBookEntryDto {
  mbNo: string;
  memberName: string;
  voucherNo: string;
  transactionType: 'CR' | 'DR';
  amount: number;
  headCode: string;
  headName: string;
  narration: string;
  username: string;
  transactionTime: Date;
}

export class DayBookSummaryDto {
  date: string;
  totalReceipts: number;
  totalPayments: number;
  netBalance: number;
  openingBalance: number;
  closingBalance: number;
  entries: DayBookEntryDto[];
  totalTransactions: number;
}

export class InterestCalculationDto {
  @IsString()
  memberCode: string;

  @IsDateString()
  fromDate: string;

  @IsDateString()
  toDate: string;

  @IsOptional()
  @IsNumber()
  interestRate?: number;
}

export class InterestPaymentDto {
  @IsString()
  memberCode: string;

  @IsNumber()
  interestAmount: number;

  @IsDateString()
  paymentDate: string;

  @IsOptional()
  @IsString()
  narration?: string;
}