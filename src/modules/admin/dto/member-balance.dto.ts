import { IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMemberBalanceDto {
    @ApiProperty({ description: 'Shares Balance' })
    @IsOptional()
    @IsNumber()
    shares?: number;

    @ApiProperty({ description: 'Recurring Deposit Balance' })
    @IsOptional()
    @IsNumber()
    rdAmount?: number;

    @ApiProperty({ description: 'Saving/Compulsory Deposit Balance' })
    @IsOptional()
    @IsNumber()
    savingAmount?: number;

    @ApiProperty({ description: 'Regular Loan Balance' })
    @IsOptional()
    @IsNumber()
    loanBalance?: number;

    @ApiProperty({ description: 'Emergency Loan Balance' })
    @IsOptional()
    @IsNumber()
    emergencyLoanBalance?: number;

    @ApiProperty({ description: 'FRS/Suspense Balance' })
    @IsOptional()
    @IsNumber()
    frsBalance?: number;
}
