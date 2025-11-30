import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';

export class TransactionResponseDto {
  @ApiProperty({ description: 'Transaction ID', example: 1 })
  @Expose()
  id: number;

  @ApiProperty({ description: 'Unique transaction number', example: 'TXN001' })
  @Expose()
  transactionNumber: string;

  @ApiProperty({ description: 'Transaction date', example: '2024-01-15' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString().split('T')[0] : value)
  transactionDate: Date;

  @ApiProperty({ description: 'Transaction type', example: 'PAYMENT' })
  @Expose()
  transactionType: string;

  @ApiProperty({ description: 'Transaction amount', example: 5000.00 })
  @Expose()
  @Transform(({ value }) => typeof value === 'string' ? parseFloat(value) : value)
  amount: number;

  @ApiProperty({ description: 'Transaction description', example: 'Loan payment' })
  @Expose()
  description: string;

  @ApiProperty({ description: 'Debit account', example: 'CASH_AC' })
  @Expose()
  debitAccount: string;

  @ApiProperty({ description: 'Credit account', example: 'LOAN_AC' })
  @Expose()
  creditAccount: string;

  @ApiPropertyOptional({ description: 'Member information' })
  @Expose()
  member?: {
    id: number;
    memberNumber: string;
    firstName: string;
    lastName: string;
    fullName: string;
  };

  @ApiPropertyOptional({ description: 'Voucher number', example: 'PV001' })
  @Expose()
  voucherNumber?: string;

  @ApiPropertyOptional({ description: 'Reference type', example: 'LOAN_PAYMENT' })
  @Expose()
  referenceType?: string;

  @ApiPropertyOptional({ description: 'Reference ID', example: 123 })
  @Expose()
  referenceId?: number;

  @ApiProperty({ description: 'Transaction status', example: 'POSTED' })
  @Expose()
  status: string;

  @ApiPropertyOptional({ description: 'Remarks', example: 'Monthly EMI payment' })
  @Expose()
  remarks?: string;

  @ApiPropertyOptional({ description: 'Reversed transaction ID' })
  @Expose()
  reversedTransactionId?: number;

  @ApiPropertyOptional({ description: 'Reversal date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString() : value)
  reversedAt?: Date;

  @ApiProperty({ description: 'Creation date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString() : value)
  createdAt: Date;

  @ApiProperty({ description: 'Last update date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString() : value)
  updatedAt: Date;

  @ApiProperty({ description: 'Whether transaction is reversed' })
  @Expose()
  isReversed: boolean;

  @ApiProperty({ description: 'Whether transaction can be reversed' })
  @Expose()
  canBeReversed: boolean;
}
