 import { IsString, IsOptional, IsDateString, IsEnum, IsNumber } from 'class-validator';

export class GetDayBookDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @IsEnum(['screen', 'printer'])
  outputType?: 'screen' | 'printer' = 'screen';

  @IsOptional()
  @IsString()
  filterType?: 'all' | 'sb' | 'savings' | 'cd' = 'all';
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
  /** Mode of payment from the ledger (C = cash, B / other = transfer). */
  modeOfPay: string;
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

/** One line of the grouped Day-Book (the all-heads report): a member's leg on a voucher. */
export class DayBookGroupEntryDto {
  mbNo: string;
  memberName: string;
  voucherNo: string;
  amount: number;
  username: string;
}

export class DayBookHeadGroupDto {
  headCode: string;
  headName: string;
  entries: DayBookGroupEntryDto[];
  total: number;
}

/**
 * The all-heads Day-Book: every ledger leg of the day except Cash-In-Hand,
 * grouped Payment (DR) / Receipt (CR) by head. Opening/closing and the two
 * totals are the real Cash-In-Hand (A1001) position and movement.
 */
export class DayBookGroupedDto {
  date: string;
  openingBalance: number;
  totalReceipts: number;
  totalPayments: number;
  netBalance: number;
  closingBalance: number;
  paymentGroups: DayBookHeadGroupDto[];
  receiptGroups: DayBookHeadGroupDto[];
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
