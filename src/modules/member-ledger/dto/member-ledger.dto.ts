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

export class GetMemberDetailLedgerDto {
  @IsNumberString()
  memberNumber: string;

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

export class MemberDetailLedgerEntryDto {
  date: string;
  accountHead: string;
  voucherNo: string;
  particulars: string;
  debit: number;
  credit: number;
  code: string;
  balance?: number;
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

export class MemberDetailLedgerSummaryDto {
  memberNumber: string;
  memberName: string;
  fromDate: string;
  toDate: string;
  openingByCode?: Record<string, number>;
  entries: MemberDetailLedgerEntryDto[];
  totalDebits: number;
  totalCredits: number;
}

export class HeadMasterDto {
  code: string;
  headName: string;
}

export class ValidateMemberDto {
  @IsNumberString()
  memberNumber: string;
}

export interface MemberLedgerHeadAvailabilityDto {
  code: string;
  headName: string;
  transactionCount: number;
  hasData: boolean;
}

export interface MemberLedgerContextDto {
  exists: boolean;
  memberName?: string;
  memberNumber: string;
  minDate: string | null;
  maxDate: string | null;
  heads: MemberLedgerHeadAvailabilityDto[];
}
