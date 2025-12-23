import { IsString, IsOptional } from 'class-validator';

export class RecoveryDetailsDto {
  @IsString()
  memberNo: string;

  @IsString()
  month: string;

  @IsString()
  year: string;

  @IsOptional()
  @IsString()
  outputType?: string;
}