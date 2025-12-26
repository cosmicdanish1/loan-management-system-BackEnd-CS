import { IsString, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MemberLedgerDto {
    @ApiProperty({ description: 'Member Number' })
    @IsString()
    memberNo: string;

    @ApiProperty({ description: 'From Date' })
    @IsDateString()
    fromDate: string;

    @ApiProperty({ description: 'To Date' })
    @IsDateString()
    toDate: string;
}
