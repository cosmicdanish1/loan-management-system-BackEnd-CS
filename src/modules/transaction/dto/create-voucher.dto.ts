import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsDateString,
  IsEnum,
  MaxLength,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateTransactionDto } from './create-transaction.dto';

export enum VoucherType {
  PAYMENT = 'PAYMENT',
  RECEIPT = 'RECEIPT',
  JOURNAL = 'JOURNAL',
  CONTRA = 'CONTRA',
}

export class VoucherTransactionDto {
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

  @ApiProperty({
    description: 'Transaction amount',
    example: 5000.00,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

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
    description: 'RD Serial Number',
    example: 'RD/001',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  rdSrNo?: string;
}

export class CreateVoucherDto {
  @ApiProperty({
    description: 'Type of voucher',
    enum: VoucherType,
    example: VoucherType.PAYMENT,
  })
  @IsEnum(VoucherType)
  @IsNotEmpty()
  voucherType: VoucherType;

  @ApiProperty({
    description: 'Voucher description',
    example: 'Monthly loan payment voucher',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional({
    description: 'Member ID if voucher is related to a member',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  memberId?: number;

  @ApiPropertyOptional({
    description: 'Voucher date (defaults to current date)',
    example: '2024-01-15',
  })
  @IsOptional()
  @IsDateString()
  voucherDate?: string;

  @ApiPropertyOptional({
    description: 'Payee name for payment vouchers',
    example: 'John Doe',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  payeeName?: string;

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

  @ApiPropertyOptional({
    description: 'Additional remarks',
    example: 'Monthly EMI payment voucher',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiProperty({
    description: 'List of transactions in this voucher',
    type: [VoucherTransactionDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VoucherTransactionDto)
  transactions: VoucherTransactionDto[];
}
