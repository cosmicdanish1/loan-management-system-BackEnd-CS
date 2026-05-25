import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class CreateRdAccountDto {
    @ApiProperty({ description: 'Account Number' })
    @IsNotEmpty()
    @IsNumber()
    accountNumber: number;

    @ApiProperty({ description: 'Member Number' })
    @IsNotEmpty()
    @IsNumber()
    memberNo: number;

    @ApiPropertyOptional({ description: 'Prefix (Mr./Mrs./Ms.)' })
    @IsOptional()
    @IsString()
    prefix: string;

    @ApiPropertyOptional({ description: 'First Name' })
    @IsOptional()
    @IsString()
    firstName: string;

    @ApiPropertyOptional({ description: 'Middle Name' })
    @IsOptional()
    @IsString()
    middleName: string;

    @ApiPropertyOptional({ description: 'Last Name' })
    @IsOptional()
    @IsString()
    lastName: string;

    @ApiPropertyOptional({ description: 'Deposit Date' })
    @IsOptional()
    depositDate: Date;

    @ApiPropertyOptional({ description: 'Installment Amount' })
    @IsOptional()
    @IsNumber()
    amount: number;

    @ApiPropertyOptional({ description: 'Interest Rate (%)' })
    @IsOptional()
    @IsNumber()
    rate: number;

    @ApiPropertyOptional({ description: 'Deposit Period' })
    @IsOptional()
    @IsNumber()
    depositPeriod: number;

    @ApiPropertyOptional({ description: 'Deposit Unit (1=Months, 2=Years)' })
    @IsOptional()
    @IsNumber()
    depositUnit: number;

    @ApiPropertyOptional({ description: 'Maturity Date' })
    @IsOptional()
    maturityDate: Date;

    @ApiPropertyOptional({ description: 'Maturity Amount' })
    @IsOptional()
    @IsNumber()
    maturityAmount: number;

    // BUG FIX 4: openingBalance was missing — INSERT was hardcoding openbal = 0
    @ApiPropertyOptional({ description: 'Opening Balance (openbal in fdmaster)' })
    @IsOptional()
    @IsNumber()
    openingBalance: number;

    @ApiPropertyOptional({ description: 'Nominee Name' })
    @IsOptional()
    @IsString()
    nominee: string;

    @ApiPropertyOptional({ description: 'Nominee Age' })
    @IsOptional()
    @IsString()
    nomineeAge: string;

    @ApiPropertyOptional({ description: 'Nominee Address' })
    @IsOptional()
    @IsString()
    nomineeAddress: string;

    @ApiPropertyOptional({ description: 'Nominee Relation' })
    @IsOptional()
    @IsString()
    nomineeRelation: string;

    @ApiPropertyOptional({ description: 'Special Instructions / Remarks' })
    @IsOptional()
    @IsString()
    specialInstructions: string;
}

// BUG FIX 3 (related): Use PartialType so update fields are all optional —
// extending CreateRdAccountDto directly inherited @IsNotEmpty() on accountNumber/memberNo,
// causing validation failures on PATCH requests that omit those fields.
export class UpdateRdAccountDto extends PartialType(CreateRdAccountDto) { }
