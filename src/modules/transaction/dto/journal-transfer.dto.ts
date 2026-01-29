import { IsString, IsNumber, IsArray, ValidateNested, IsOptional, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export class JournalRowDto {
    @IsOptional()
    @IsNumber()
    mbno?: number;

    @IsOptional()
    @IsString()
    code?: string;

    @IsNumber()
    debit: number;

    @IsNumber()
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
