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

export enum ReceiptMethod {
  CASH = 'CASH',
  CHEQUE = 'CHEQUE',
  BANK_TRANSFER = 'BANK_TRANSFER',
}

export class CreateReceiptVoucherDto {
  @ApiProperty({
    description: 'Member ID for the receipt',
    example: 1,
  })
  @IsNumber()
  memberId: number;

  @ApiProperty({
    description: 'Receipt amount',
    example: 5000.00,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @ApiProperty({
    description: 'Receipt description',
    example: 'Loan EMI payment',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiProperty({
    description: 'Receipt method',
    enum: ReceiptMethod,
    example: ReceiptMethod.CASH,
  })
  @IsEnum(ReceiptMethod)
  receiptMethod: ReceiptMethod;

  @ApiPropertyOptional({
    description: 'Cheque number if payment by cheque',
    example: '123456',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  chequeNumber?: string;

  @ApiPropertyOptional({
    description: 'Cheque date',
    example: '2024-01-15',
  })
  @IsOptional()
  @IsDateString()
  chequeDate?: string;

  @ApiPropertyOptional({
    description: 'Bank name for cheque payments',
    example: 'State Bank of India',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiProperty({
    description: 'Account code being credited (usually CASH or BANK)',
    example: 'CASH_AC',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  accountCode: string;

  @ApiProperty({
    description: 'Income account being debited',
    example: 'LOAN_INTEREST_INCOME',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  incomeAccount: string;

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
