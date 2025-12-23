import { IsString, IsOptional } from 'class-validator';

export class RecurringDetailsDto {
  @IsString()
  memberNo: string;

  @IsOptional()
  @IsString()
  outputType?: string;
}