import { IsNumber, IsOptional, IsString, IsNotEmpty, Min, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOfficeDto {
    @ApiProperty({ description: 'Office Number' })
    @IsOptional()
    @IsNumber()
    @Min(0)
    officeId?: number;

    @ApiProperty({ description: 'Office Name' })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    officeName?: string;

    @ApiProperty({ description: 'Division / Regional Office' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    division?: string;

    @ApiProperty({ description: 'Address' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    address?: string;

    @ApiProperty({ description: 'City' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    city?: string;
}

export class UpdateOfficeDto extends CreateOfficeDto { }
