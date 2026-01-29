import { IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOfficeDto {
    @ApiProperty({ description: 'Office Number' })
    @IsOptional()
    @IsNumber()
    officeId?: number;

    @ApiProperty({ description: 'Office Name' })
    @IsOptional()
    @IsString()
    officeName?: string;

    @ApiProperty({ description: 'Division / Regional Office' })
    @IsOptional()
    @IsString()
    division?: string;

    @ApiProperty({ description: 'Address' })
    @IsOptional()
    @IsString()
    address?: string;

    @ApiProperty({ description: 'City' })
    @IsOptional()
    @IsString()
    city?: string;
}

export class UpdateOfficeDto extends CreateOfficeDto { }
