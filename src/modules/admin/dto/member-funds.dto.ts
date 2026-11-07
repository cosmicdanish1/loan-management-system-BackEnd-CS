import { IsNumber, IsOptional, Min, Max } from 'class-validator';

// rupees and paise only: no negative balances, nothing beyond 99,99,99,999.99 (ES-300)
const MAX_AMT = 999_999_999.99;
const AMT = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };
import { ApiProperty } from '@nestjs/swagger';

export class UpdateMemberFundsDto {
    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    sharesOpeningBalance?: number;

    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    sharesInstallment?: number;

    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    monthlyContributionOpeningBalance?: number;

    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    monthlyContributionInstallment?: number;

    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    compulsoryDepositOpeningBalance?: number;

    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    compulsoryDepositInstallment?: number;

    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    loanExecutionReceipt?: number;

    @ApiProperty() @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    suspenseBalance?: number;

    @ApiProperty({ description: 'Regular Loan Opening Balance (md1_opbal)' })
    @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    rlnOpBal?: number;

    @ApiProperty({ description: 'Regular Loan Installment Amount (md1_amount)' })
    @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    rlnAmt?: number;

    @ApiProperty({ description: 'Emergency Loan Opening Balance (md2_opbal)' })
    @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    elnOpBal?: number;

    @ApiProperty({ description: 'Emergency Loan Installment Amount (md2_amount)' })
    @IsNumber(AMT) @Min(0) @Max(MAX_AMT) @IsOptional()
    elnAmt?: number;
}
