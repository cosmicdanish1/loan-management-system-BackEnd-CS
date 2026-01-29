import { IsString, IsNumber, IsArray, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class CDDistributionItemDto {
    @IsNumber()
    memberNo: number;

    @IsString()
    memberName: string;

    @IsNumber()
    currentBalance: number;

    @IsNumber()
    postAmount: number;
}

export class PostCDTransactionDto {
    @IsString()
    incomeHeadCode: string;

    @IsNumber()
    totalAmount: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CDDistributionItemDto)
    distributions: CDDistributionItemDto[];

    @IsOptional()
    @IsString()
    narration?: string;
}

export class CDMemberSummaryDto {
    memberNo: number;
    memberName: string;
    currentBalance: number;
}
