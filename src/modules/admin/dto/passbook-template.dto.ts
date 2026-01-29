import { IsString, IsNotEmpty, IsBoolean, IsArray, ValidateNested, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class PassbookFieldDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    rowPos: number;

    @IsNumber()
    colPos: number;

    @IsBoolean()
    @IsOptional()
    isVisible?: boolean;

    @IsBoolean()
    @IsOptional()
    isLabelVisible?: boolean;

    @IsString()
    @IsNotEmpty()
    fieldType: string;
}

export class PassbookPagePositionDto {
    @IsString()
    @IsOptional()
    bankFormat?: string;

    @IsNumber()
    @IsOptional()
    totalPages?: number;

    @IsNumber()
    @IsOptional()
    linesPerPage?: number;

    @IsNumber()
    @IsOptional()
    lineStartNumber?: number;

    @IsNumber()
    @IsOptional()
    incrementLevel?: number;
}

export class CreatePassbookTemplateDto {
    @IsString()
    @IsNotEmpty()
    templateName: string;

    @IsString()
    @IsNotEmpty()
    accountType: string;

    @IsBoolean()
    @IsOptional()
    isDefault?: boolean;

    @ValidateNested()
    @Type(() => PassbookPagePositionDto)
    pageSettings: PassbookPagePositionDto;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PassbookFieldDto)
    fields: PassbookFieldDto[];
}

export class UpdatePassbookTemplateDto extends CreatePassbookTemplateDto { }
