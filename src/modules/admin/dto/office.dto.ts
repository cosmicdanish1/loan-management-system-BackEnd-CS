import { IsInt, IsOptional, IsString, IsNotEmpty, Min, Max, MaxLength, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, PartialType } from '@nestjs/swagger';

export class CreateOfficeDto {
    @ApiProperty({ description: 'Office (Branch) Number. Leave out for a new branch: the server gives the next number.' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(2147483647)
    officeId?: number;

    @ApiProperty({ description: 'Office Name' })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    officeName?: string;

    @ApiProperty({ description: 'Wing code (Division / RO) the office belongs to' })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(6)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    wingId?: string;

    @ApiProperty({ description: 'Division number the legacy keeps for the office (the office number when left out)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(2147483647)
    division?: number;

    @ApiProperty({ description: 'Address' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    address?: string;

    @ApiProperty({ description: 'City (up to 20 characters)' })
    @IsOptional()
    @IsString()
    @MaxLength(20)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    city?: string;
}

// An update sends only what changes; the office is named by the URL.
export class UpdateOfficeDto extends PartialType(CreateOfficeDto) { }
