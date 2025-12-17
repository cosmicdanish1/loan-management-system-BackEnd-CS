import { IsString, IsNotEmpty, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class CashBookMonthlyDto {
    @IsString()
    @IsNotEmpty()
    month: string; // e.g., 'Apr'

    @Type(() => Number)
    @IsNumber()
    @IsNotEmpty()
    year: number; // e.g., 2015
}
