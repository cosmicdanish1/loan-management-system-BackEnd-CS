import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

export class AccountClosingRegisterDto {
  @IsOptional()
  @IsString()
  accountType?: string; // 'FD', 'RD', 'REGULAR_LOAN', 'ALL', etc.

  @IsInt()
  @Min(1)
  @Max(12)
  @Transform(({ value }) => parseInt(value))
  month: number; // 1-12

  @IsInt()
  @Min(1900)
  @Max(2100)
  @Transform(({ value }) => parseInt(value))
  year: number; // e.g., 2024

  @IsOptional()
  @IsString()
  outputType?: string; // 'screen' or 'printer'
}