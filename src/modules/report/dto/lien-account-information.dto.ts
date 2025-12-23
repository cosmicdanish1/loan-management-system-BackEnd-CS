import { IsOptional, IsString } from 'class-validator';

export class LienAccountInformationDto {
  @IsOptional()
  @IsString()
  outputType?: string;
}