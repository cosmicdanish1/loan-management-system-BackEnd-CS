import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import { TransactionResponseDto } from './transaction-response.dto';

export class VoucherResponseDto {
  @ApiProperty({ description: 'Voucher ID', example: 1 })
  @Expose()
  id: number;

  @ApiProperty({ description: 'Unique voucher number', example: 'PV001' })
  @Expose()
  voucherNumber: string;

  @ApiProperty({ description: 'Voucher date', example: '2024-01-15' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString().split('T')[0] : value)
  voucherDate: Date;

  @ApiProperty({ description: 'Voucher type', example: 'PAYMENT' })
  @Expose()
  voucherType: string;

  @ApiProperty({ description: 'Total voucher amount', example: 5000.00 })
  @Expose()
  @Transform(({ value }) => typeof value === 'string' ? parseFloat(value) : value)
  totalAmount: number;

  @ApiProperty({ description: 'Voucher description', example: 'Monthly loan payment' })
  @Expose()
  description: string;

  @ApiPropertyOptional({ description: 'Member information' })
  @Expose()
  member?: {
    id: number;
    memberNumber: string;
    firstName: string;
    lastName: string;
    fullName: string;
  };

  @ApiPropertyOptional({ description: 'Payee name', example: 'John Doe' })
  @Expose()
  payeeName?: string;

  @ApiPropertyOptional({ description: 'Cheque number', example: '123456' })
  @Expose()
  chequeNumber?: string;

  @ApiPropertyOptional({ description: 'Cheque date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString().split('T')[0] : value)
  chequeDate?: Date;

  @ApiPropertyOptional({ description: 'Bank name', example: 'State Bank of India' })
  @Expose()
  bankName?: string;

  @ApiProperty({ description: 'Voucher status', example: 'ACTIVE' })
  @Expose()
  status: string;

  @ApiPropertyOptional({ description: 'Remarks', example: 'Monthly EMI payment' })
  @Expose()
  remarks?: string;

  @ApiPropertyOptional({ description: 'Authorized by user ID' })
  @Expose()
  authorizedBy?: number;

  @ApiPropertyOptional({ description: 'Authorization date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString() : value)
  authorizedAt?: Date;

  @ApiPropertyOptional({ description: 'Cancelled by user ID' })
  @Expose()
  cancelledBy?: number;

  @ApiPropertyOptional({ description: 'Cancellation date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString() : value)
  cancelledAt?: Date;

  @ApiPropertyOptional({ description: 'Cancellation reason' })
  @Expose()
  cancellationReason?: string;

  @ApiPropertyOptional({ 
    description: 'Associated transactions',
    type: [TransactionResponseDto]
  })
  @Expose()
  @Type(() => TransactionResponseDto)
  transactions?: TransactionResponseDto[];

  @ApiProperty({ description: 'Creation date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString() : value)
  createdAt: Date;

  @ApiProperty({ description: 'Last update date' })
  @Expose()
  @Transform(({ value }) => value instanceof Date ? value.toISOString() : value)
  updatedAt: Date;

  @ApiProperty({ description: 'Whether voucher is cancelled' })
  @Expose()
  isCancelled: boolean;

  @ApiProperty({ description: 'Whether voucher is authorized' })
  @Expose()
  isAuthorized: boolean;

  @ApiProperty({ description: 'Whether voucher can be cancelled' })
  @Expose()
  canBeCancelled: boolean;
}
