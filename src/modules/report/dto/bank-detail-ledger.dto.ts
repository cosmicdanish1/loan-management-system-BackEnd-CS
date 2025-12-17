import { IsString, IsNotEmpty, IsDateString } from 'class-validator';

export class BankDetailLedgerDto {
    @IsString()
    @IsNotEmpty()
    bank_head_code: string; // e.g., 'A1009'

    @IsDateString()
    @IsNotEmpty()
    from_date: string; // e.g., '2024-01-01'

    @IsDateString()
    @IsNotEmpty()
    to_date: string; // e.g., '2024-12-31'
}
