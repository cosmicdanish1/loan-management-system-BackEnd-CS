import { IsString, IsNumber, IsOptional, MaxLength, IsNotEmpty, Min, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCastCategoryDto {
    @ApiProperty({ description: 'Unique category ID' })
    @IsNumber()
    @Min(0)
    id: number;

    @ApiProperty({ description: 'Name of the caste category', maxLength: 30 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(30)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    name: string;
}

export class UpdateCastCategoryDto {
    @ApiPropertyOptional({ description: 'Name of the caste category', maxLength: 30 })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(30)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    name?: string;
}
