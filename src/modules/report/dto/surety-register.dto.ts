import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class SuretyRegisterDto {
    @IsNotEmpty()
    @IsString()
    memberFrom: string;

    @IsNotEmpty()
    @IsString()
    memberTo: string;

    @IsOptional()
    @IsString()
    loanType?: string;
}
