import { IsOptional, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class DefaulterListDto {
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    minBalance?: number; // Minimum outstanding balance to show (default: 0)

    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    minDaysOverdue?: number; // Not used yet, but ready for future enhancement
}
