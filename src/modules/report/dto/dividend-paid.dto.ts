import { IsOptional, IsString, IsDateString } from 'class-validator';

export class DividendPaidDto {
    @IsOptional()
    @IsString()
    wingName?: string; // Wing filter

    @IsOptional()
    @IsDateString()
    fromDate?: string; // From date for payment period

    @IsOptional()
    @IsDateString()
    toDate?: string; // To date for payment period
}
