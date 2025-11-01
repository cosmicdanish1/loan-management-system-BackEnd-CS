import { IsDateString, IsOptional, IsString, IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class DepositClosureDto {
  @ApiProperty({ description: 'Closure date' })
  @IsDateString()
  closureDate: string;

  @ApiProperty({ description: 'Reason for closure' })
  @IsString()
  closureReason: string;

  @ApiProperty({ description: 'Penalty rate for premature closure', required: false, default: 1 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  penaltyRate?: number;
}

export class DepositMaturityDto {
  @ApiProperty({ description: 'Maturity processing date' })
  @IsDateString()
  maturityDate: string;

  @ApiProperty({ description: 'Auto-renewal flag', required: false, default: false })
  @IsOptional()
  @IsString()
  renewalAction?: 'RENEW' | 'CLOSE' | 'TRANSFER';

  @ApiProperty({ description: 'New tenure for renewal in months', required: false })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  newTenureMonths?: number;
}
