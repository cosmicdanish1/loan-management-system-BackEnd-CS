import { IsNumber, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateMemberFundsDto {
    @ApiProperty() @IsNumber() @IsOptional()
    sharesOpeningBalance?: number;

    @ApiProperty() @IsNumber() @IsOptional()
    sharesInstallment?: number;

    @ApiProperty() @IsNumber() @IsOptional()
    monthlyContributionOpeningBalance?: number;

    @ApiProperty() @IsNumber() @IsOptional()
    monthlyContributionInstallment?: number;

    @ApiProperty() @IsNumber() @IsOptional()
    compulsoryDepositOpeningBalance?: number;

    @ApiProperty() @IsNumber() @IsOptional()
    compulsoryDepositInstallment?: number;

    @ApiProperty() @IsNumber() @IsOptional()
    loanExecutionReceipt?: number;

    @ApiProperty() @IsNumber() @IsOptional()
    suspenseBalance?: number;

    @ApiProperty({ description: 'Regular Loan Opening Balance (md1_opbal)' })
    @IsNumber() @IsOptional()
    rlnOpBal?: number;

    @ApiProperty({ description: 'Regular Loan Installment Amount (md1_amount)' })
    @IsNumber() @IsOptional()
    rlnAmt?: number;

    @ApiProperty({ description: 'Emergency Loan Opening Balance (md2_opbal)' })
    @IsNumber() @IsOptional()
    elnOpBal?: number;

    @ApiProperty({ description: 'Emergency Loan Installment Amount (md2_amount)' })
    @IsNumber() @IsOptional()
    elnAmt?: number;
}
