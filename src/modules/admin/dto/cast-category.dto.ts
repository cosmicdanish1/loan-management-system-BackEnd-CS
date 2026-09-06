import { IsString, IsNumber, IsOptional, IsPositive, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCastCategoryDto {
    @ApiProperty({ description: 'Unique category ID' })
    @IsNumber()
    @IsPositive()
    id: number;

    @ApiProperty({ description: 'Name of the caste category', maxLength: 30 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(30)
    name: string;
}

export class UpdateCastCategoryDto {
    @ApiPropertyOptional({ description: 'Name of the caste category', maxLength: 30 })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(30)
    name?: string;
}
