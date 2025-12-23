import { IsNumber, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export class ExecuteReportScheduleDto {
    @Type(() => Number)
    @IsNumber()
    scheduleId: number;

    @IsDateString()
    fromDate: string;

    @IsDateString()
    toDate: string;

    @IsDateString()
    financialYearStart: string; // For progressive (YTD) calculations
}
