import { IsString, IsOptional, IsIn } from 'class-validator';

export class AdHocReportsDto {
  @IsString()
  @IsIn(['member_wise', 'account_wise', 'transaction_wise', 'balance_summary', 'loan_summary', 'deposit_summary', 'custom'])
  reportType: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsString()
  memberNo?: string;

  @IsOptional()
  @IsString()
  accountType?: string;

  @IsOptional()
  @IsString()
  customQuery?: string;

  @IsOptional()
  @IsString()
  outputType?: string;
}