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
  officeNo: string;
  officeName: string;
  fromDate: string;
  toDate: string;
  openingByCode: Record<string, number>;
  entries: MemberDetailLedgerEntryDto[];
  totalDebits: number;
  totalCredits: number;
}

// Columnar member detail ledger (legacy "MEMBER DETAIL LEDGER" — 4 fixed account columns)
export class ColumnarCellDto {
  dr: number;
  cr: number;
  bal: number | null; // null when the account had no activity that date
}

export class ColumnarRowDto {
  date: string;
  share: ColumnarCellDto;   // L1001 SHARE VALUE        (bal = Cr - Dr)
  ltl: ColumnarCellDto;     // A1002 REGULAR LOAN       (bal = Dr - Cr, outstanding)
  emer: ColumnarCellDto;    // A1047 EMERGENCY LOAN     (bal = Dr - Cr, outstanding)
  cd: ColumnarCellDto;      // L1004 COMPULSORY DEPOSIT (bal = Cr - Dr)
}

export class ColumnarBalancesDto {
  share: number;
  ltl: number;
  emer: number;
  cd: number;
}

export class MemberColumnarLedgerDto {
  memberNumber: string;
  memberName: string;
  fromDate: string;
  toDate: string;
  opening: ColumnarBalancesDto;
  closing: ColumnarBalancesDto;
  rows: ColumnarRowDto[];
}

export class HeadMasterDto {
  code: string;
  headName: string;
}

export class ValidateMemberDto {
  @IsNumberString()
  memberNumber: string;
}