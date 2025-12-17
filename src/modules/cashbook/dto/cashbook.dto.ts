import { IsDateString, IsOptional, IsString, IsNumber } from 'class-validator';

export class GetCashBookDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  outputType?: 'screen' | 'printer';
}

export class CashBookEntryDto {
  code: string;
  headName: string;
  receipt: number;
  payment: number;
  balance?: number;
}

export class CashBookSummaryDto {
  date: string;
  totalReceipts: number;
  totalPayments: number;
  netBalance: number;
  entries: CashBookEntryDto[];
  openingBalance: number;
  closingBalance: number;
}

export class CreateTransactionDto {
  @IsString()
  transType: string; // 'CR' or 'DR'

  @IsDateString()
  transDate: string;

  @IsOptional()
  @IsString()
  memberCode?: string; // mbno

  @IsString()
  headCode: string; // code

  @IsString()
  headName: string; // for display purposes

  @IsNumber()
  debit: number;

  @IsNumber()
  credit: number;

  @IsOptional()
  @IsString()
  narration?: string;

  @IsOptional()
  @IsString()
  voucherNo?: string; // receipt_vchr_no

  @IsOptional()
  @IsString()
  createdBy?: string; // username
}