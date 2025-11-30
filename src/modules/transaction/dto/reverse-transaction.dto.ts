import {
  IsString,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReverseTransactionDto {
  @ApiProperty({
    description: 'Reason for reversing the transaction',
    example: 'Incorrect amount posted',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
