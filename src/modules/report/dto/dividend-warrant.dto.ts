import { IsOptional, IsString, IsDateString, IsIn } from 'class-validator';

export class DividendWarrantDto {
    @IsOptional()
    @IsString()
    wingName?: string;

    @IsOptional()
    @IsString()
    officeName?: string;

    @IsOptional()
    @IsDateString()
    fromDate?: string;

    @IsOptional()
    @IsDateString()
    uptoDate?: string;

    @IsOptional()
    @IsString()
    memberNo?: string; // Specific member filter

    @IsOptional()
    @IsIn(['MBNO', 'NAME', 'AMOUNT'])
    sortBy?: string;
}
