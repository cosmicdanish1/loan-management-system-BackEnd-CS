import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DepositMaturityDto {
    @ApiProperty({ description: 'Start date for maturity range' })
    @IsDateString()
    fromDate: string;

    @ApiProperty({ description: 'End date for maturity range' })
    @IsDateString()
    toDate: string;

    @ApiProperty({ description: 'Filter by deposit type (FD/RD)', required: false })
    @IsString()
    @IsOptional()
    depositType?: string;
}
