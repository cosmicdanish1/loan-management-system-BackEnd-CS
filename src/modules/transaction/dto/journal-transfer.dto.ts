import { IsString, IsNumber, IsArray, ValidateNested, IsOptional, IsEnum, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class JournalRowDto {
    @IsOptional()
    @IsNumber()
    mbno?: number;

    @IsOptional()
    @IsString()
    code?: string;

    @IsNumber()
    @Min(0)
    debit: number;

    @IsNumber()
    @Min(0)
    credit: number;

    @IsOptional()
    @IsString()
    narration?: string;

    @IsOptional()
    @IsString()
    rdSdSrNo?: string;
}

export class CreateJournalVoucherDto {
    @IsEnum(['headToHead', 'memberToMember'])
    transferType: 'headToHead' | 'memberToMember';

    @IsString()
    narration: string;

    @IsOptional()
    @IsString()
    chequeNo?: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => JournalRowDto)
    rows: JournalRowDto[];
}
