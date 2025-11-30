import { IsNumber, IsPositive, IsDateString, IsOptional, IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type, Expose } from 'class-transformer';

export class CreateRdInstallmentDto {
  @ApiProperty({ description: 'Recurring deposit ID' })
  @IsNumber()
  @IsPositive()
  recurringDepositId: number;

  @ApiProperty({ description: 'Installment number' })
  @IsNumber()
  @IsPositive()
  installmentNumber: number;

  @ApiProperty({ description: 'Installment amount' })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  amount: number;

  @ApiProperty({ description: 'Due date for installment' })
  @IsDateString()
  dueDate: string;
}

export class PayRdInstallmentDto {
  @ApiProperty({ description: 'Payment amount' })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  paidAmount: number;

  @ApiProperty({ description: 'Payment date' })
  @IsDateString()
  paidDate: string;

  @ApiProperty({ description: 'Payment mode', required: false })
  @IsOptional()
  @IsString()
  @IsIn(['CASH', 'CHEQUE', 'ONLINE', 'TRANSFER'])
  paymentMode?: string;

  @ApiProperty({ description: 'Receipt number', required: false })
  @IsOptional()
  @IsString()
  receiptNumber?: string;

  @ApiProperty({ description: 'Payment remarks', required: false })
  @IsOptional()
  @IsString()
  remarks?: string;
}

export class RdInstallmentResponseDto {
  @ApiProperty()
  @Expose()
  id: number;

  @ApiProperty()
  @Expose()
  recurringDepositId: number;

  @ApiProperty()
  @Expose()
  installmentNumber: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  amount: number;

  @ApiProperty()
  @Expose()
  dueDate: Date;

  @ApiProperty({ required: false })
  @Expose()
  paidDate?: Date;

  @ApiProperty({ required: false })
  @Expose()
  @Type(() => Number)
  paidAmount?: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  penaltyAmount: number;

  @ApiProperty()
  @Expose()
  status: string;

  @ApiProperty({ required: false })
  @Expose()
  remarks?: string;

  @ApiProperty({ required: false })
  @Expose()
  receiptNumber?: string;

  @ApiProperty({ required: false })
  @Expose()
  paymentMode?: string;

  @ApiProperty()
  @Expose()
  createdAt: Date;

  @ApiProperty()
  @Expose()
  updatedAt: Date;

  // Computed properties
  @ApiProperty()
  @Expose()
  get isOverdue(): boolean {
    return this.status === 'PENDING' && new Date() > this.dueDate;
  }

  @ApiProperty()
  @Expose()
  get daysPastDue(): number {
    if (!this.isOverdue) return 0;
    const today = new Date();
    const due = new Date(this.dueDate);
    const diffTime = today.getTime() - due.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  @ApiProperty()
  @Expose()
  get outstandingAmount(): number {
    if (this.status === 'PAID') return 0;
    return Number(this.amount) + Number(this.penaltyAmount) - Number(this.paidAmount || 0);
  }
}
