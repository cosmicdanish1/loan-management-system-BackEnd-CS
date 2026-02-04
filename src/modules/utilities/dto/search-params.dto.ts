import { IsNotEmpty, IsString, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SearchDepositsDto {
    @ApiProperty({ description: 'Member number' })
    @IsNotEmpty()
    @IsString()
    memberNo: string;

    @ApiProperty({ description: 'Deposit type', enum: ['RD', 'FD'] })
    @IsNotEmpty()
    @IsEnum(['RD', 'FD'])
    type: 'RD' | 'FD';
}

export class SearchSBAccountsDto {
    @ApiProperty({ description: 'Member number' })
    @IsNotEmpty()
    @IsString()
    memberNo: string;
}

export class MemberEligibilityDto {
    @ApiProperty({ description: 'Member number' })
    @IsNotEmpty()
    @IsString()
    memberNo: string;
}

export class MemberBalanceDto {
    @ApiProperty({ description: 'Member number' })
    @IsNotEmpty()
    @IsString()
    memberNo: string;
}
