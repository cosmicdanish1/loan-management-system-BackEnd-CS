import { IsString, IsOptional, IsDateString, IsEnum } from 'class-validator';

export class GetConsolidationDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @IsEnum(['screen', 'printer'])
  outputType?: 'screen' | 'printer' = 'screen';
}

export class ConsolidationEntryDto {
  headCode: string;
  headName: string;
  receipts: number;
  payments: number;
  netAmount: number;
}

export class ConsolidationSummaryDto {
  date: string;
  totalReceipts: number;
  totalPayments: number;
  netBalance: number;
  entries: ConsolidationEntryDto[];
  totalHeads: number;
}