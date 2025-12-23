import { Type } from 'class-transformer';
import { IsString, IsArray, ValidateNested, ArrayMinSize } from 'class-validator';

export class ReportScheduleDetailDto {
    @IsString()
    particulars: string;

    @IsString()
    code_from: string;

    @IsString()
    code_to: string;
}

export class CreateReportScheduleDto {
    @IsString()
    schedule_name: string;

    @IsString()
    template_name: string;

    @IsString()
    report_type: string;

    @IsArray()
    @ValidateNested({ each: true })
    @ArrayMinSize(1)
    @Type(() => ReportScheduleDetailDto)
    details: ReportScheduleDetailDto[];
}
