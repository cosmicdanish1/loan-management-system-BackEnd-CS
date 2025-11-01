import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsDateString,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TransactionType {
  PAYMENT = 'PAYMENT',
  RECEIPT = 'RECEIPT',
  TRANSFER = 'TRANSFER',
  JOURNAL = 'JOURNAL',
}

export class CreateTransactionDto {
  @ApiProperty({
    description: 'Type of transaction',
    enum: TransactionType,
    example: TransactionType.PAYMENT,
  })
  @IsEnum(TransactionType)
  @IsNotEmpty()
  transactionType: TransactionType;

  @ApiProperty({
    description: 'Transaction amount',
    example: 5000.00,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @ApiProperty({
    description: 'Transaction description',
    example: 'Loan payment for account LA001',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiProperty({
    description: 'Debit account code',
    example: 'CASH_AC',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  debitAccount: string;

  @ApiProperty({
    description: 'Credit account code',
    example: 'LOAN_AC',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  creditAccount: string;

  @ApiPropertyOptional({
    description: 'Member ID if transaction is related to a member',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  memberId?: number;

  @ApiPropertyOptional({
    description: 'Transaction date (defaults to current date)',
    example: '2024-01-15',
  })
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @ApiPropertyOptional({
    description: 'Voucher number if part of a voucher',
    example: 'PV001',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  voucherNumber?: string;

  @ApiPropertyOptional({
    description: 'Reference type for linking to other entities',
    example: 'LOAN_PAYMENT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  referenceType?: string;

  @ApiPropertyOptional({
    description: 'Reference ID for linking to other entities',
    example: 123,
  })
  @IsOptional()
  @IsNumber()
  referenceId?: number;

  @ApiPropertyOptional({
    description: 'Additional remarks',
    example: 'Monthly EMI payment',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
