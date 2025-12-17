import { IsString, IsDateString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GetGeneralLedgerDto {
  @ApiProperty({ description: 'Head code for the account' })
  @IsString()
  headCode: string;

  @ApiProperty({ description: 'From date for the report' })
  @IsDateString()
  fromDate: string;

  @ApiProperty({ description: 'To date for the report' })
  @IsDateString()
  toDate: string;

  @ApiProperty({ description: 'Output type', enum: ['screen', 'printer'], required: false })
  @IsOptional()
  @IsIn(['screen', 'printer'])
  outputType?: string;
}

export class GeneralLedgerEntryDto {
  @ApiProperty({ description: 'Transaction number' })
  transactionNo: number;

  @ApiProperty({ description: 'Transaction date' })
  transactionDate: string;

  @ApiProperty({ description: 'Voucher number' })
  voucherNo: string;

  @ApiProperty({ description: 'Transaction narration' })
  narration: string;

  @ApiProperty({ description: 'Debit amount' })
  debit: number;

  @ApiProperty({ description: 'Credit amount' })
  credit: number;

  @ApiProperty({ description: 'Running balance' })
  balance: number;

  @ApiProperty({ description: 'Transaction type' })
  transactionType: 'DR' | 'CR';

  @ApiProperty({ description: 'Member number (if applicable)' })
  memberNumber?: number;

  @ApiProperty({ description: 'Account number (if applicable)' })
  accountNumber?: number;

  @ApiProperty({ description: 'Username who created the transaction' })
  username: string;
}

export class GeneralLedgerSummaryDto {
  @ApiProperty({ description: 'Head code' })
  headCode: string;

  @ApiProperty({ description: 'Head name' })
  headName: string;

  @ApiProperty({ description: 'From date' })
  fromDate: string;

  @ApiProperty({ description: 'To date' })
  toDate: string;

  @ApiProperty({ description: 'Opening balance' })
  openingBalance: number;

  @ApiProperty({ description: 'Total debits' })
  totalDebits: number;

  @ApiProperty({ description: 'Total credits' })
  totalCredits: number;

  @ApiProperty({ description: 'Closing balance' })
  closingBalance: number;

  @ApiProperty({ description: 'Ledger entries', type: [GeneralLedgerEntryDto] })
  entries: GeneralLedgerEntryDto[];

  @ApiProperty({ description: 'Total number of transactions' })
  totalTransactions: number;
}

export class HeadMasterDto {
  @ApiProperty({ description: 'Head code' })
  code: string;

  @ApiProperty({ description: 'Head name' })
  headName: string;

  @ApiProperty({ description: 'Head type' })
  headType?: string;

  @ApiProperty({ description: 'Parent code' })
  parentCode?: string;
}