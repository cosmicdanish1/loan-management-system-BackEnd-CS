import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';

export class MemberLoanDetailsDto {
  // Loan Information
  @ApiProperty({ description: 'Loan Case Number' })
  @Expose()
  loanCaseNo: string;

  @ApiProperty({ description: 'Loan Type (ALN, RLN, ELN, MLN)' })
  @Expose()
  loanType: string;

  @ApiProperty({ description: 'Applied Amount' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  appliedAmount: number;

  @ApiProperty({ description: 'Application Date' })
  @Expose()
  applicationDate: Date;

  @ApiProperty({ description: 'Sanctioned Amount' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  sanctionedAmount: number;

  @ApiProperty({ description: 'Sanction Date' })
  @Expose()
  sanctionDate: Date;

  @ApiProperty({ description: 'Rate of Interest' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  rate: number;

  @ApiProperty({ description: 'Number of Installments' })
  @Expose()
  noOfInstallments: number;

  @ApiProperty({ description: 'Installment Amount' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  installmentAmount: number;

  @ApiProperty({ description: 'Outstanding Balance' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  balance: number;

  @ApiProperty({ description: 'Purpose of Loan' })
  @Expose()
  purpose: string;

  // Member Information
  @ApiProperty({ description: 'Member Number' })
  @Expose()
  memberNumber: string;

  @ApiProperty({ description: 'Member Name' })
  @Expose()
  memberName: string;

  @ApiProperty({ description: 'Office Number and Name' })
  @Expose()
  officeName: string;

  @ApiProperty({ description: 'Basic Pay' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  basicPay: number;

  @ApiProperty({ description: 'Loan Status (Pending/Sanctioned/Paid)' })
  @Expose()
  status: string;
}

export class LoanMasterDetailsDto {
  @ApiProperty({ description: 'Loan Case Number' })
  @Expose()
  loanCaseNo: string;

  @ApiProperty({ description: 'Member Number' })
  @Expose()
  memberNumber: string;

  @ApiProperty({ description: 'Loan Type' })
  @Expose()
  loanType: string;

  @ApiProperty({ description: 'Loan Amount' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  loanAmount: number;

  @ApiProperty({ description: 'Payment/Disbursement Date' })
  @Expose()
  paymentDate: Date;

  @ApiProperty({ description: 'Rate of Interest' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  rate: number;

  @ApiProperty({ description: 'Number of Installments' })
  @Expose()
  noOfInstallments: number;

  @ApiProperty({ description: 'Installment Amount' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  installmentAmount: number;

  @ApiProperty({ description: 'Outstanding Balance' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  balance: number;

  @ApiProperty({ description: 'Purpose' })
  @Expose()
  purpose: string;

  @ApiProperty({ description: 'Interest Amount' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  interestAmount: number;

  @ApiProperty({ description: 'Penal Rate' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  penalRate: number;

  // Member Details
  @ApiProperty({ description: 'Member Name' })
  @Expose()
  memberName: string;

  @ApiProperty({ description: 'Office Name' })
  @Expose()
  officeName: string;

  @ApiProperty({ description: 'Basic Pay' })
  @Expose()
  @Transform(({ value }) => value ? Number(value) : 0)
  basicPay: number;
}
