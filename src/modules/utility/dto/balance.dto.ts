import { IsNumber, IsOptional, IsDateString, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MemberBalanceInquiryDto {
  @ApiProperty({ description: 'Member ID' })
  @Type(() => Number)
  @IsNumber()
  memberId: number;

  @ApiPropertyOptional({ description: 'As of date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  asOfDate?: string;
}

export class AccountStatementDto {
  @ApiProperty({ description: 'Member ID' })
  @Type(() => Number)
  @IsNumber()
  memberId: number;

  @ApiPropertyOptional({ description: 'Account type (loan, deposit, share)' })
  @IsOptional()
  @IsString()
  accountType?: string;

  @ApiPropertyOptional({ description: 'Account ID' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  accountId?: number;

  @ApiProperty({ description: 'From date (YYYY-MM-DD)' })
  @IsDateString()
  fromDate: string;

  @ApiProperty({ description: 'To date (YYYY-MM-DD)' })
  @IsDateString()
  toDate: string;

  @ApiPropertyOptional({ description: 'Include closed accounts', default: false })
  @IsOptional()
  @Type(() => Boolean)
  includeClosed?: boolean = false;
}

export interface MemberBalance {
  memberId: number;
  memberNumber: string;
  memberName: string;
  shareBalance: number;
  totalLoanBalance: number;
  totalDepositBalance: number;
  netBalance: number;
  lastTransactionDate: Date;
  asOfDate: Date;
}

export interface AccountBalance {
  accountId: number;
  accountNumber: string;
  accountType: string;
  currentBalance: number;
  availableBalance: number;
  lastTransactionDate: Date;
  status: string;
}

export interface AccountStatement {
  member: {
    id: number;
    memberNumber: string;
    name: string;
  };
  account: {
    id: number;
    accountNumber: string;
    accountType: string;
    openingBalance: number;
    closingBalance: number;
  };
  period: {
    fromDate: Date;
    toDate: Date;
  };
  transactions: AccountStatementTransaction[];
  summary: {
    totalDebits: number;
    totalCredits: number;
    transactionCount: number;
  };
}

export interface AccountStatementTransaction {
  date: Date;
  transactionNumber: string;
  description: string;
  debitAmount: number;
  creditAmount: number;
  balance: number;
  voucherNumber?: string;
  remarks?: string;
}
