import { IsNumber, IsOptional, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateMemberFundsDto {
    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    sharesOpeningBalance?: number;

    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    sharesInstallment?: number;

    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    monthlyContributionOpeningBalance?: number;

    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    monthlyContributionInstallment?: number;

    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    compulsoryDepositOpeningBalance?: number;

    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    compulsoryDepositInstallment?: number;

    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    loanExecutionReceipt?: number;

    @ApiProperty() @IsNumber() @IsOptional() @Min(0)
    suspenseBalance?: number;

    @ApiProperty({ description: 'Regular Loan Opening Balance (md1_opbal)' })
    @IsNumber() @IsOptional() @Min(0)
    rlnOpBal?: number;

    @ApiProperty({ description: 'Regular Loan Installment Amount (md1_amount)' })
    @IsNumber() @IsOptional() @Min(0)
    rlnAmt?: number;

    @ApiProperty({ description: 'Emergency Loan Opening Balance (md2_opbal)' })
    @IsNumber() @IsOptional() @Min(0)
    elnOpBal?: number;

    @ApiProperty({ description: 'Emergency Loan Installment Amount (md2_amount)' })
    @IsNumber() @IsOptional() @Min(0)
    elnAmt?: number;
}
