import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';

export class LoanMemberDto {
  @ApiProperty({ description: 'Member ID' })
  @Expose()
  id: number;

  @ApiProperty({ description: 'Member number' })
  @Expose()
  memberNumber: string;

  @ApiProperty({ description: 'Member first name' })
  @Expose()
  firstName: string;

  @ApiProperty({ description: 'Member last name' })
  @Expose()
  lastName: string;

  @ApiProperty({ description: 'Member full name' })
  @Expose()
  @Transform(({ obj }) => `${obj.firstName} ${obj.lastName}`)
  fullName: string;
}

export class LoanResponseDto {
  @ApiProperty({ description: 'Loan account ID' })
  @Expose()
  id: number;

  @ApiProperty({ description: 'Loan account number' })
  @Expose()
  accountNumber: string;

  @ApiProperty({ description: 'Member information' })
  @Expose()
  @Type(() => LoanMemberDto)
  member: LoanMemberDto;

  @ApiProperty({ description: 'Principal loan amount' })
  @Expose()
  @Transform(({ value }) => Number(value))
  principalAmount: number;

  @ApiProperty({ description: 'Interest rate' })
  @Expose()
  @Transform(({ value }) => Number(value))
  interestRate: number;

  @ApiProperty({ description: 'Outstanding balance' })
  @Expose()
  @Transform(({ value }) => Number(value))
  outstandingBalance: number;

  @ApiProperty({ description: 'Loan type' })
  @Expose()
  loanType: string;

  @ApiProperty({ description: 'Disbursement date' })
  @Expose()
  disbursementDate: Date;

  @ApiProperty({ description: 'Maturity date' })
  @Expose()
  maturityDate: Date;

  @ApiProperty({ description: 'Tenure in months' })
  @Expose()
  tenureMonths: number;

  @ApiProperty({ description: 'EMI amount' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : null)
  emiAmount: number;

  @ApiProperty({ description: 'Purpose of loan' })
  @Expose()
  purpose: string;

  @ApiProperty({ description: 'Surety name' })
  @Expose()
  suretyName: string;

  @ApiProperty({ description: 'Surety phone' })
  @Expose()
  suretyPhone: string;

  @ApiProperty({ description: 'Surety address' })
  @Expose()
  suretyAddress: string;

  @ApiProperty({ description: 'Loan status' })
  @Expose()
  status: string;

  @ApiProperty({ description: 'Total interest accrued' })
  @Expose()
  @Transform(({ value }) => Number(value))
  totalInterestAccrued: number;

  @ApiProperty({ description: 'Total amount paid' })
  @Expose()
  @Transform(({ value }) => Number(value))
  totalPaid: number;

  @ApiProperty({ description: 'Last interest calculation date' })
  @Expose()
  lastInterestCalculationDate: Date;

  @ApiProperty({ description: 'Closure date' })
  @Expose()
  closureDate: Date;

  @ApiProperty({ description: 'Is loan overdue' })
  @Expose()
  isOverdue: boolean;

  @ApiProperty({ description: 'Remaining balance' })
  @Expose()
  remainingBalance: number;

  @ApiProperty({ description: 'Created date' })
  @Expose()
  createdAt: Date;

  @ApiProperty({ description: 'Updated date' })
  @Expose()
  updatedAt: Date;
}
