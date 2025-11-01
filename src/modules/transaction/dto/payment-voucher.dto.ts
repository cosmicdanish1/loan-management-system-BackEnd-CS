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

export enum PaymentMethod {
  CASH = 'CASH',
  CHEQUE = 'CHEQUE',
  BANK_TRANSFER = 'BANK_TRANSFER',
}

export class CreatePaymentVoucherDto {
  @ApiPropertyOptional({
    description: 'Member ID if payment is related to a member',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  memberId?: number;

  @ApiProperty({
    description: 'Name of the payee',
    example: 'John Doe',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  payeeName: string;

  @ApiProperty({
    description: 'Payment amount',
    example: 5000.00,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @ApiProperty({
    description: 'Payment description',
    example: 'Office rent payment',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiProperty({
    description: 'Payment method',
    enum: PaymentMethod,
    example: PaymentMethod.CASH,
  })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

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
    description: 'Account code being debited (usually CASH or BANK)',
    example: 'CASH_AC',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  accountCode: string;

  @ApiProperty({
    description: 'Expense account being credited',
    example: 'OFFICE_RENT_EXP',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  expenseAccount: string;

  @ApiPropertyOptional({
    description: 'Reference type for linking to other entities',
    example: 'EXPENSE_PAYMENT',
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
    example: 'Monthly office rent payment',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
