import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AnnualMemberStatementDto {
    @ApiProperty({ description: 'Wing Number', required: false })
    @IsString()
    @IsOptional()
    wingNo?: string;

    @ApiProperty({ description: 'Office/Branch Number', required: false })
    @IsString()
    @IsOptional()
    officeNo?: string;

    @ApiProperty({ description: 'As On Date' })
    @IsDateString()
    asOnDate: string;
}
