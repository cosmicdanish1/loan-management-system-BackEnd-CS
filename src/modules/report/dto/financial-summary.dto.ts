import { IsDateString, IsNotEmpty, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class FinancialSummaryDto {
    @IsDateString()
    @IsNotEmpty()
    fromDate: string; // e.g., '2015-04-01'

    @IsDateString()
    @IsNotEmpty()
    toDate: string; // e.g., '2016-03-31'

    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    includeOpBal: boolean; // Include opening balance

    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    hideZeroClosing: boolean; // Suppress accounts with zero closing balance

    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    hideZeroTrans: boolean; // Suppress accounts with zero transaction activity
}
