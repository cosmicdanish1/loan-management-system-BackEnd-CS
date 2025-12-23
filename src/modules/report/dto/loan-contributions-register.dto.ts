import { IsString, IsOptional } from 'class-validator';

export class LoanContributionsRegisterDto {
  @IsString()
  memberNo: string;

  @IsString()
  fromDate: string;

  @IsString()
  toDate: string;

  @IsOptional()
  @IsString()
  outputType?: string;
}