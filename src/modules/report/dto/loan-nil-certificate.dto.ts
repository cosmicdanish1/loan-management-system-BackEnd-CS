import { IsNotEmpty, IsString } from 'class-validator';

export class LoanNilCertificateDto {
    @IsNotEmpty()
    @IsString()
    memberNo: string;
}
