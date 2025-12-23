import { IsOptional, IsString, IsIn } from 'class-validator';

export class InterestListDto {
    @IsOptional()
    @IsString()
    wingName?: string; // Wing filter

    @IsOptional()
    @IsString()
    financialYear?: string; // Financial year

    @IsOptional()
    @IsIn(['CD', 'MD', 'SHARE', 'ALL'])
    accountType?: string; // Account type filter

    @IsOptional()
    @IsIn(['MBNO', 'NAME', 'BALANCE'])
    sortBy?: string; // Sort by
}
