import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWingDto {
    @ApiProperty({ description: 'Wing Code' })
    @IsString()
    wingId: string;

    @ApiProperty({ description: 'Wing Name' })
    @IsOptional()
    @IsString()
    wingName?: string;

    @ApiProperty({ description: 'State / Jurisdictional Status (1 or 0)' })
    @IsOptional()
    @IsString()
    state?: string;
}

export class UpdateWingDto extends CreateWingDto { }
