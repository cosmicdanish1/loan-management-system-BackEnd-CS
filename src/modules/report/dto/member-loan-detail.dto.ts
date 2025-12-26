import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MemberLoanDetailDto {
    @ApiProperty({ description: 'Starting Member Number' })
    @IsString()
    memberFrom: string;

    @ApiProperty({ description: 'Ending Member Number' })
    @IsString()
    memberTo: string;

    @ApiProperty({ description: 'Loan Type (e.g. ALN, RLN, ELN)', required: false })
    @IsString()
    @IsOptional()
    loanType?: string;
}
