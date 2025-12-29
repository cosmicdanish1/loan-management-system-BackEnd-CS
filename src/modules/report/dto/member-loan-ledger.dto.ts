import { IsString, IsNotEmpty, IsDateString, IsEnum, IsOptional } from 'class-validator';

export enum LoanCategory {
    REGULAR = 'REGULAR',
    SHORT_TERM = 'SHORT_TERM'
}

export class MemberLoanLedgerDto {
    @IsString()
    @IsNotEmpty()
    memberCode: string; // e.g., '10001'

    @IsDateString()
    @IsNotEmpty()
    asOnDate: string; // e.g., '2024-12-31'

    @IsEnum(LoanCategory)
    @IsOptional()
    loanCategory?: LoanCategory; // 'REGULAR' or 'SHORT_TERM'

    @IsString()
    @IsOptional()
    headCode?: string;
}
