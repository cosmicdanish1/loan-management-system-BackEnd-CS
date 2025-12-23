import { IsString, IsOptional } from 'class-validator';

export class FixedDepositCertificateDto {
  @IsString()
  memberNo: string; // Required - Member Number

  @IsOptional()
  @IsString()
  certificateNo?: string; // Optional - Specific Certificate Number

  @IsOptional()
  @IsString()
  outputType?: string; // 'screen' or 'printer'
}