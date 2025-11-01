import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';

export class PaymentResponseDto {
  @ApiProperty({ description: 'Payment ID' })
  @Expose()
  id: number;

  @ApiProperty({ description: 'Payment number' })
  @Expose()
  paymentNumber: string;

  @ApiProperty({ description: 'Loan account ID' })
  @Expose()
  loanAccountId: number;

  @ApiProperty({ description: 'Payment amount' })
  @Expose()
  @Transform(({ value }) => Number(value))
  amount: number;

  @ApiProperty({ description: 'Principal amount' })
  @Expose()
  @Transform(({ value }) => Number(value))
  principalAmount: number;

  @ApiProperty({ description: 'Interest amount' })
  @Expose()
  @Transform(({ value }) => Number(value))
  interestAmount: number;

  @ApiProperty({ description: 'Penalty amount' })
  @Expose()
  @Transform(({ value }) => Number(value))
  penaltyAmount: number;

  @ApiProperty({ description: 'Payment date' })
  @Expose()
  paymentDate: Date;

  @ApiProperty({ description: 'Payment method' })
  @Expose()
  paymentMethod: string;

  @ApiProperty({ description: 'Reference number' })
  @Expose()
  referenceNumber: string;

  @ApiProperty({ description: 'Remarks' })
  @Expose()
  remarks: string;

  @ApiProperty({ description: 'Receipt number' })
  @Expose()
  receiptNumber: string;

  @ApiProperty({ description: 'Payment status' })
  @Expose()
  status: string;

  @ApiProperty({ description: 'Balance after payment' })
  @Expose()
  @Transform(({ value }) => Number(value))
  balanceAfterPayment: number;

  @ApiProperty({ description: 'Created date' })
  @Expose()
  createdAt: Date;

  @ApiProperty({ description: 'Updated date' })
  @Expose()
  updatedAt: Date;
}
