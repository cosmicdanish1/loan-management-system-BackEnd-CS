import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TransferType {
  SHARE_TRANSFER = 'SHARE_TRANSFER',
  DEPOSIT_TRANSFER = 'DEPOSIT_TRANSFER',
  LOAN_ADJUSTMENT = 'LOAN_ADJUSTMENT',
}

export class CreateBalanceTransferDto {
  @ApiProperty({
    description: 'Source member ID',
    example: 1,
  })
  @IsNumber()
  fromMemberId: number;

  @ApiProperty({
    description: 'Destination member ID',
    example: 2,
  })
  @IsNumber()
  toMemberId: number;

  @ApiProperty({
    description: 'Transfer amount',
    example: 5000.00,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @ApiProperty({
    description: 'Transfer description',
    example: 'Share transfer between members',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiProperty({
    description: 'Type of balance transfer',
    enum: TransferType,
    example: TransferType.SHARE_TRANSFER,
  })
  @IsEnum(TransferType)
  transferType: TransferType;

  @ApiPropertyOptional({
    description: 'Additional remarks',
    example: 'Transfer approved by manager',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class RollbackTransactionDto {
  @ApiProperty({
    description: 'Reason for rolling back the transaction',
    example: 'Incorrect amount posted due to data entry error',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
