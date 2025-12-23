import { IsNotEmpty, IsString } from 'class-validator';

export class InterestCertificateDto {
    @IsNotEmpty()
    @IsString()
    memberNo: string;

    @IsNotEmpty()
    @IsString()
    fromDate: string;

    @IsNotEmpty()
    @IsString()
    toDate: string;
}
