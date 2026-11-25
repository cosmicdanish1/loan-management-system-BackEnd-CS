import { IsOptional, IsString, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, PartialType } from '@nestjs/swagger';

export const WING_STATE_MESSAGE = 'Invalid State. Use 1 (In State) or 0 (Out State).';

export class CreateWingDto {
    @ApiProperty({ description: 'Wing Code (up to 6 characters)' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(6)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    wingId: string;

    @ApiProperty({ description: 'Wing Name' })
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(45)
    @Matches(/^[^<>]*$/, { message: 'must not contain < or >' })
    wingName?: string;

    @ApiProperty({ description: 'State: 1 = In State, 0 = Out State' })
    @IsOptional()
    // 1 or 0 only; WingService.parseState refuses anything else with the legacy message "Invalid State"
    // (the global validation answer would replace the text of a DTO check)
    @Transform(({ value }) => (value === null || value === undefined ? value : String(value).trim()))
    @IsString()
    state?: string;
}

// ES-306: an update sends only what changes; the wing is named by the URL. (It used to extend the create DTO, so a
// PATCH without wingId was a 400 "wingId must be a string".)
export class UpdateWingDto extends PartialType(CreateWingDto) { }
