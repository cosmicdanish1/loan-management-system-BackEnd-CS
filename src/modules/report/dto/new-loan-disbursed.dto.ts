import { IsString, IsNotEmpty, IsDateString, IsOptional } from 'class-validator';

export class NewLoanDisbursedDto {
    @IsOptional()
    @IsString()
    loanType?: string; // e.g., 'RLN', 'ELN', etc. Optional - if not provided, shows all types

    @IsDateString()
    @IsNotEmpty()
    fromDate: string; // e.g., '2024-01-01'
}
