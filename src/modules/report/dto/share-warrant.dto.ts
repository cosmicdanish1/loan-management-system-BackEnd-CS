import { IsString, IsOptional, IsDateString, IsEnum } from 'class-validator';

export enum ShareWarrantOutputType {
  SCREEN = 'screen',
  PRINTER = 'printer'
}

export class ShareWarrantDto {
  @IsOptional()
  @IsString()
  memberNo?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  wingName?: string;

  @IsOptional()
  @IsString()
  officeName?: string;

  @IsOptional()
  @IsEnum(ShareWarrantOutputType)
  outputType?: ShareWarrantOutputType;
}