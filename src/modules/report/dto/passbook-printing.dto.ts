import { IsString, IsOptional, IsNumberString, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class PassBookPrintingDto {
  @IsString()
  memberNo: string;

  @IsOptional()
  @IsString()
  accountNo?: string;

  @IsOptional()
  @IsString()
  accountType?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeZeroBalance?: boolean;

  @IsOptional()
  @IsNumberString()
  printCopies?: string;

  @IsOptional()
  @IsString()
  outputType?: string;
}