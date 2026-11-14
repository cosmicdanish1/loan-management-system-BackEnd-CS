import { IsOptional, IsString, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWingDto {
    @ApiProperty({ description: 'Wing Code' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(20)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    wingId: string;

    @ApiProperty({ description: 'Wing Name' })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    wingName?: string;

    @ApiProperty({ description: 'State / Jurisdictional Status (1 or 0)' })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(50)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    state?: string;
}

export class UpdateWingDto extends CreateWingDto { }
