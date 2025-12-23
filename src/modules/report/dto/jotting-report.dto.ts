
import { IsNotEmpty, IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class JottingReportDto {
    @ApiProperty({ description: 'Head Code for the report (e.g. RLN, CD)' })
    @IsNotEmpty()
    @IsString()
    headCode: string;

    @ApiProperty({ description: 'Cut-off Date (YYYY-MM-DD)' })
    @IsNotEmpty()
    @IsDateString()
    asOnDate: string;

    @ApiProperty({ description: 'Wing Name for filtering', required: false })
    @IsOptional()
    @IsString()
    wingName?: string;

    @ApiProperty({ description: 'Office Name for filtering', required: false })
    @IsOptional()
    @IsString()
    officeName?: string;

    @ApiProperty({ description: 'Sort By: MBNO or NAME', required: false })
    @IsOptional()
    @IsString()
    sortBy?: string;
}
