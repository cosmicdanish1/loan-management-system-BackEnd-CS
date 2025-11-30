import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class RecurringDepositResponseDto {
  @ApiProperty()
  @Expose()
  id: number;

  @ApiProperty()
  @Expose()
  accountNumber: string;

  @ApiProperty()
  @Expose()
  memberId: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  monthlyInstallment: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  interestRate: number;

  @ApiProperty()
  @Expose()
  startDate: Date;

  @ApiProperty()
  @Expose()
  maturityDate: Date;

  @ApiProperty()
  @Expose()
  tenureMonths: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  maturityAmount: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  totalDeposited: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  interestAccrued: number;

  @ApiProperty()
  @Expose()
  installmentsPaid: number;

  @ApiProperty()
  @Expose()
  installmentsMissed: number;

  @ApiProperty()
  @Expose()
  status: string;

  @ApiProperty({ required: false })
  @Expose()
  closureDate?: Date;

  @ApiProperty({ required: false })
  @Expose()
  @Type(() => Number)
  closureAmount?: number;

  @ApiProperty({ required: false })
  @Expose()
  @Type(() => Number)
  penaltyAmount?: number;

  @ApiProperty({ required: false })
  @Expose()
  closureReason?: string;

  @ApiProperty({ required: false })
  @Expose()
  lastInstallmentDate?: Date;

  @ApiProperty({ required: false })
  @Expose()
  nextDueDate?: Date;

  @ApiProperty()
  @Expose()
  createdAt: Date;

  @ApiProperty()
  @Expose()
  updatedAt: Date;

  // Computed properties
  @ApiProperty()
  @Expose()
  get isMatured(): boolean {
    return new Date() >= this.maturityDate;
  }

  @ApiProperty()
  @Expose()
  get remainingInstallments(): number {
    return this.tenureMonths - this.installmentsPaid;
  }

  @ApiProperty()
  @Expose()
  get isOverdue(): boolean {
    if (!this.nextDueDate || this.status !== 'ACTIVE') return false;
    return new Date() > this.nextDueDate;
  }

  @ApiProperty()
  @Expose()
  get currentValue(): number {
    if (this.status === 'CLOSED') {
      return Number(this.closureAmount || 0);
    }
    return Number(this.totalDeposited) + Number(this.interestAccrued);
  }
}
