import { IsString, IsBoolean, IsArray, ValidateNested, IsOptional, IsInt, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class CertificateFieldDto {
    @IsOptional()
    @IsInt()
    id?: number;

    @IsString()
    @IsNotEmpty()
    label: string;

    @IsString()
    @IsNotEmpty()
    dataKey: string;

    @IsInt()
    rowPos: number;

    @IsInt()
    colPos: number;

    @IsInt()
    @IsOptional()
    length: number;

    @IsString()
    @IsOptional()
    transformMode: string;

    @IsBoolean()
    @IsOptional()
    isVisible: boolean;
}

export class CreateCertificateTemplateDto {
    @IsString()
    @IsNotEmpty()
    templateName: string;

    @IsString()
    @IsNotEmpty()
    accountType: string;

    @IsBoolean()
    @IsOptional()
    isDefault: boolean;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CertificateFieldDto)
    fields: CertificateFieldDto[];
}

export class UpdateCertificateTemplateDto extends CreateCertificateTemplateDto { }
