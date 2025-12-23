import { IsString, IsNotEmpty, IsISO8601 } from 'class-validator';

export class MemberStatementDto {
    @IsString()
    @IsNotEmpty()
    memberNo: string;

    @IsISO8601()
    @IsNotEmpty()
    fromDate: string;

    @IsISO8601()
    @IsNotEmpty()
    toDate: string;
}
