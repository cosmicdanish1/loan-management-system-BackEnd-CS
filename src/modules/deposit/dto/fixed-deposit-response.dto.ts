import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class FixedDepositResponseDto {
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
  principalAmount: number;

  @ApiProperty()
  @Expose()
  @Type(() => Number)
  interestRate: number;

  @ApiProperty()
  @Expose()
  depositDate: Date;

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
  interestAccrued: number;

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

  @ApiProperty()
  @Expose()
  isAutoRenewal: boolean;

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
  get daysToMaturity(): number {
    const today = new Date();
    const maturity = new Date(this.maturityDate);
    const diffTime = maturity.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  @ApiProperty()
  @Expose()
  get currentValue(): number {
    if (this.status === 'CLOSED') {
      return Number(this.closureAmount || 0);
    }
    return Number(this.principalAmount) + Number(this.interestAccrued);
  }
}
