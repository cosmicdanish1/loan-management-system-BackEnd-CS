import { IsString, IsOptional, IsDateString, IsEnum, IsNumberString } from 'class-validator';

export class GetMemberLedgerDto {
  @IsNumberString()
  memberNumber: string;

  @IsString()
  headCode: string;

  @IsDateString()
  fromDate: string;

  @IsDateString()
  toDate: string;

  @IsOptional()
  @IsEnum(['screen', 'printer'])
  outputType?: 'screen' | 'printer' = 'screen';
}

export class MemberLedgerEntryDto {
  transactionNo: number;
  transactionDate: Date;
  voucherNo: string;
  narration: string;
  debit: number;
  credit: number;
  balance: number;
  transactionType: 'DR' | 'CR';
  username: string;
}

export class MemberLedgerSummaryDto {
  memberNumber: string;
  memberName: string;
  headCode: string;
  headName: string;
  fromDate: string;
  toDate: string;
  openingBalance: number;
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
  entries: MemberLedgerEntryDto[];
  totalTransactions: number;
}

export class HeadMasterDto {
  code: string;
  headName: string;
}

export class ValidateMemberDto {
  @IsNumberString()
  memberNumber: string;
}