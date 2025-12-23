import { IsOptional, IsString, IsNumber, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class DividendReportDto {
    @IsOptional()
    @IsString()
    wingName?: string; // Wing filter

    @IsOptional()
    @IsString()
    officeName?: string; // Office filter

    @IsOptional()
    @IsString()
    financialYear?: string; // Financial year (e.g., "2024-2025")

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    dividendRate?: number; // Dividend percentage (e.g., 10 for 10%)

    @IsOptional()
    @IsIn(['MBNO', 'NAME', 'SHARE_AMT'])
    sortBy?: string; // Sort by Member No, Name, or Share Amount
}
