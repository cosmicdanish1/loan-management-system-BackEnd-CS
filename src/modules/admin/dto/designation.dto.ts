import { IsString, IsNumber, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDesignationDto {
    @ApiProperty({ description: 'Unique designation code', maxLength: 20 })
    @IsString()
    @MaxLength(20)
    code: string;

    @ApiProperty({ description: 'Name of the designation', maxLength: 100 })
    @IsString()
    @MaxLength(100)
    name: string;

    @ApiPropertyOptional({ description: 'Hierarchy level of the designation' })
    @IsOptional()
    @IsNumber()
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
    level?: number;
}
