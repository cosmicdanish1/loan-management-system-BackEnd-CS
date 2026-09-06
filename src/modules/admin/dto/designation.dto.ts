import { IsString, IsNumber, IsOptional, IsNotEmpty, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDesignationDto {
    @ApiProperty({ description: 'Unique designation code', maxLength: 20 })
    // Trim + uppercase before validation so 'DES001' and 'des001' can't
    // end up as two distinct rows, and whitespace-only input is caught
    // by IsNotEmpty instead of silently becoming a blank PK.
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
    @IsString()
    @IsNotEmpty()
    @MaxLength(20)
    code: string;

    @ApiProperty({ description: 'Name of the designation', maxLength: 100 })
    @IsString()
    @MaxLength(100)
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
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ description: 'Hierarchy level of the designation' })
    @IsOptional()
    @IsNumber()
    @Min(0)
    level?: number;
}
