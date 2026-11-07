import { IsNumber, IsOptional, IsString, ValidateNested, Min, Max } from 'class-validator';

// rupees and paise only: no negative balances, nothing beyond 99,99,99,999.99 (ES-300)
const MAX_AMT = 999_999_999.99;
const AMT = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMemberBalanceDto {
    @ApiProperty({ description: 'Shares Balance' })
    @IsOptional()
    @IsNumber(AMT)
    @Min(0)
    @Max(MAX_AMT)
    shares?: number;

    @ApiProperty({ description: 'Recurring Deposit Balance' })
    @IsOptional()
    @IsNumber(AMT)
    @Min(0)
    @Max(MAX_AMT)
    rdAmount?: number;

    @ApiProperty({ description: 'Saving/Compulsory Deposit Balance' })
    @IsOptional()
    @IsNumber(AMT)
    @Min(0)
    @Max(MAX_AMT)
    savingAmount?: number;

    @ApiProperty({ description: 'Regular Loan Balance' })
    @IsOptional()
    @IsNumber(AMT)
    @Min(0)
    @Max(MAX_AMT)
    loanBalance?: number;

    @ApiProperty({ description: 'Emergency Loan Balance' })
    @IsOptional()
    @IsNumber(AMT)
    @Min(0)
    @Max(MAX_AMT)
    emergencyLoanBalance?: number;

    @ApiProperty({ description: 'FRS/Suspense Balance' })
    @IsOptional()
    @IsNumber(AMT)
    @Min(-MAX_AMT)
    @Max(MAX_AMT)
    frsBalance?: number;
}
