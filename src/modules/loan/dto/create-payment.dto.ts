import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsString,
  IsDateString,
  IsOptional,
  IsPositive,
  IsIn,
  Length,
} from 'class-validator';

export class CreateLoanPaymentDto {
  @ApiProperty({
    description: 'Loan account ID',
    example: 1,
  })
  @IsNumber()
  @IsNotEmpty()
  loanAccountId: number;

  @ApiProperty({
    description: 'Payment amount',
    example: 5000,
    minimum: 1,
  })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({
    description: 'Principal amount portion of payment',
    example: 4000,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  principalAmount?: number;

  @ApiProperty({
    description: 'Interest amount portion of payment',
    example: 1000,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  interestAmount?: number;

  @ApiProperty({
    description: 'Penalty amount portion of payment',
    example: 0,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  penaltyAmount?: number;

  @ApiProperty({
    description: 'Payment date',
    example: '2024-01-15',
  })
  @IsDateString()
  paymentDate: string;

  @ApiProperty({
    description: 'Payment method',
    example: 'CASH',
    enum: ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI'],
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI'])
  paymentMethod: string;

  @ApiProperty({
    description: 'Reference number (cheque number, transaction ID, etc.)',
    example: 'CHQ123456',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  referenceNumber?: string;

  @ApiProperty({
    description: 'Payment remarks',
    example: 'Monthly EMI payment',
    required: false,
  })
  @IsOptional()
  @IsString()
  remarks?: string;
}
