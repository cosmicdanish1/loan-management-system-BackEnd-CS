import { PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn } from 'class-validator';
import { CreateRecurringDepositDto } from './create-recurring-deposit.dto';

export class UpdateRecurringDepositDto extends PartialType(CreateRecurringDepositDto) {
  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'MATURED', 'CLOSED', 'DEFAULTED'])
  status?: string;

  @IsOptional()
  @IsString()
  closureReason?: string;
}
