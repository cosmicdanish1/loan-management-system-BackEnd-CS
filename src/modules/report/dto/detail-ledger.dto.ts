import { IsString, IsNotEmpty, IsDateString } from 'class-validator';

export class DetailLedgerDto {
    @IsString()
    @IsNotEmpty()
    head_code: string; // e.g., 'H003'

    @IsDateString()
    @IsNotEmpty()
    from_date: string; // e.g., '2024-01-01'

    @IsDateString()
    @IsNotEmpty()
    to_date: string; // e.g., '2024-12-31'
}
