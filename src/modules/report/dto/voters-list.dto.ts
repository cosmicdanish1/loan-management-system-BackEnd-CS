import { IsOptional, IsString, IsIn } from 'class-validator';

export class VotersListDto {
    @IsOptional()
    @IsString()
    division?: string; // Division/RO filter

    @IsOptional()
    @IsString()
    branch?: string; // Branch/Office filter

    @IsOptional()
    @IsIn(['ACTIVE', 'INACTIVE', 'ALL'])
    memberStatus?: string; // Active, Inactive, or All members

    @IsOptional()
    @IsIn(['MBNO', 'NAME', 'DOJ'])
    sortBy?: string; // Sort by Member No, Name, or Date of Joining
}
