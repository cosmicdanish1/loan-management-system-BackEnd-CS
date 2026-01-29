import { IsString, IsNumber, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCastCategoryDto {
    @ApiProperty({ description: 'Unique category ID' })
    @IsNumber()
    id: number;

    @ApiProperty({ description: 'Name of the caste category', maxLength: 30 })
    @IsString()
    @MaxLength(30)
    name: string;
}

export class UpdateCastCategoryDto {
    @ApiPropertyOptional({ description: 'Name of the caste category', maxLength: 30 })
    @IsOptional()
    @IsString()
    @MaxLength(30)
    name?: string;
}
