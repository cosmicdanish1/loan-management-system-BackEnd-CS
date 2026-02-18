import { PartialType } from '@nestjs/swagger';

import { IsOptional, IsString, IsIn } from 'class-validator';
import { CreateFixedDepositDto } from './create-fixed-deposit.dto';

export class UpdateFixedDepositDto extends PartialType(CreateFixedDepositDto) {
  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'MATURED', 'CLOSED', 'PREMATURE_CLOSURE'])
  status?: string;

  @IsOptional()
  @IsString()
  closureReason?: string;
}
