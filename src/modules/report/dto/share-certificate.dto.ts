import { IsString, IsOptional, IsNumberString } from 'class-validator';

export class ShareCertificateDto {
  @IsString()
  memberNo: string;

  @IsOptional()
  @IsNumberString()
  shareFrom?: string;

  @IsOptional()
  @IsNumberString()
  shareTo?: string;

  @IsOptional()
  @IsString()
  certificateNo?: string;

  @IsOptional()
  @IsString()
  outputType?: string;
}