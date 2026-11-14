import { IsString, IsNumber, IsOptional, MaxLength, IsNotEmpty, Min, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDesignationDto {
    @ApiProperty({ description: 'Unique designation code', maxLength: 20 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(20)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    code: string;

    @ApiProperty({ description: 'Name of the designation', maxLength: 100 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    name: string;

    @ApiPropertyOptional({ description: 'Hierarchy level of the designation' })
    @IsOptional()
    @IsNumber()
    @Min(0)
    level?: number;
}

export class UpdateDesignationDto {
    @ApiPropertyOptional({ description: 'Name of the designation', maxLength: 100 })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    name?: string;

    @ApiPropertyOptional({ description: 'Hierarchy level of the designation' })
    @IsOptional()
    @IsNumber()
    @Min(0)
    level?: number;
}
