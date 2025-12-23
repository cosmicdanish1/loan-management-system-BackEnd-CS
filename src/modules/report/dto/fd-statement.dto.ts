import { IsString, IsNotEmpty, IsISO8601, IsOptional } from 'class-validator';

export class FDStatementDto {
    @IsString()
    @IsNotEmpty()
    memberNo: string;

    @IsISO8601()
    @IsNotEmpty()
    fromDate: string;

    @IsISO8601()
    @IsNotEmpty()
    toDate: string;

    @IsString()
    @IsOptional()
    headCode?: string;
}
