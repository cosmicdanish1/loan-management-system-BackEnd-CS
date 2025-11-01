import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateTransactionDto } from './create-transaction.dto';

export class UpdateTransactionDto extends PartialType(CreateTransactionDto) {
  @ApiPropertyOptional({
    description: 'Additional remarks for the update',
    example: 'Updated transaction description',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  updateRemarks?: string;
}
