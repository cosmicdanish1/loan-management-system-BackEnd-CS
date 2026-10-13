import { IsNotEmpty, IsNumber, IsOptional, IsString, IsDecimal, Matches, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PartialType } from '@nestjs/swagger';

export class CreateSbAccountDto {
    @ApiProperty({ description: 'Account Number' })
    @IsNotEmpty()
    @IsString()
    // ledger.acc_no is a NUMERIC column — a non-numeric account number crashes the
    // opening-balance posting with a raw DB error. Reject it up front instead.
    @Matches(/^\d+$/, { message: 'Account number must contain digits only' })
    accountNo: string;

    @ApiProperty({ description: 'Member Number' })
    @IsNotEmpty()
    @IsString()
    memberNo: string;

    @ApiProperty({ description: 'Opening Date' })
    @IsOptional()
    openingDate: Date;

    @ApiProperty({ description: 'Opening Balance' })
    @IsOptional()
    @IsNumber()
    @Min(0, { message: 'Opening balance cannot be negative' })
    openingBalance: number;

    @ApiProperty({ description: 'Ledger Group' })
    @IsOptional()
    @IsString()
    ledgerGroup: string;

    @ApiProperty({ description: 'Special Instructions' })
    @IsOptional()
    @IsString()
    specialInstructions: string;

    @ApiProperty({ description: 'Nominee Name' })
    @IsOptional()
    @IsString()
    nomineeName: string;

    @ApiProperty({ description: 'Nominee Age' })
    @IsOptional()
    @IsString()
    nomineeAge: string;

    @ApiProperty({ description: 'Nominee Address' })
    @IsOptional()
    @IsString()
    nomineeAddress: string;

    @ApiProperty({ description: 'Nominee Relation' })
    @IsOptional()
    @IsString()
    nomineeRelation: string;
}

// BUG FIX: PartialType makes all fields optional — extending CreateSbAccountDto directly
// inherited @IsNotEmpty() on accountNo/memberNo, causing PATCH validation failures.
export class UpdateSbAccountDto extends PartialType(CreateSbAccountDto) { }
