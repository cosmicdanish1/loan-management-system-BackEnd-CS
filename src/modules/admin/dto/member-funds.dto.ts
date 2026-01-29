import { IsNumber, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateMemberFundsDto {
    @ApiProperty({ description: 'Monthly Contribution (MD) Installment Amount' })
    @IsNumber()
    @IsOptional()
    monthlyContributionInstallment?: number;

    @ApiProperty({ description: 'Compulsory Deposit (CD) Installment Amount' })
    @IsNumber()
    @IsOptional()
    compulsoryDepositInstallment?: number;

    @ApiProperty({ description: 'Shares Installment Amount' })
    @IsNumber()
    @IsOptional()
    sharesInstallment?: number;

    @ApiProperty({ description: 'Monthly Contribution Opening Balance' })
    @IsNumber()
    @IsOptional()
    monthlyContributionOpeningBalance?: number;

    @ApiProperty({ description: 'Shares Opening Balance' })
    @IsNumber()
    @IsOptional()
    sharesOpeningBalance?: number;

    @ApiProperty({ description: 'Compulsory Deposit Opening Balance' })
    @IsNumber()
    @IsOptional()
    compulsoryDepositOpeningBalance?: number;

    @ApiProperty({ description: 'Compulsory Deposit Suspense Balance' })
    @IsNumber()
    @IsOptional()
    suspenseBalance?: number;
}
