import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class YearlyMemberStatementDto {
    @ApiProperty({ description: 'From Date' })
    @IsDateString()
    fromDate: string;

    @ApiProperty({ description: 'To Date' })
    @IsDateString()
    toDate: string;

    @ApiProperty({ description: 'Wing Number', required: false })
    @IsString()
    @IsOptional()
    wingNo?: string;

    @ApiProperty({ description: 'Office Number', required: false })
    @IsString()
    @IsOptional()
    officeNo?: string;

    @ApiProperty({ description: 'From Member Number' })
    @IsString()
    fromMemberNo: string;

    @ApiProperty({ description: 'To Member Number' })
    @IsString()
    toMemberNo: string;

    @ApiProperty({ description: 'Sort By', required: false })
    @IsString()
    @IsOptional()
    sortBy?: string;
}
