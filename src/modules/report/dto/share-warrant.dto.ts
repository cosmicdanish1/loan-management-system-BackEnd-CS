import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ShareWarrantDto {
  @ApiProperty({ description: 'Starting Member Number' })
  @IsString()
  memberFrom: string;

  @ApiProperty({ description: 'Ending Member Number' })
  @IsString()
  memberTo: string;

  @ApiProperty({ description: 'Warrant Date', required: false })
  @IsDateString()
  @IsOptional()
  warrantDate?: string;
}