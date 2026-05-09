import { IsNotEmpty, IsNumber, IsOptional, IsString, IsDecimal } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRdAccountDto {
    @ApiProperty({ description: 'Account Number' })
    @IsNotEmpty()
    @IsNumber()
    accountNumber: number;

    @ApiProperty({ description: 'Member Number' })
    @IsNotEmpty()
    @IsNumber()
    memberNo: number;

    @ApiProperty({ description: 'Prefix' })
    @IsOptional()
    @IsString()
    prefix: string;

    @ApiProperty({ description: 'First Name' })
    @IsOptional()
    @IsString()
    firstName: string;

    @ApiProperty({ description: 'Middle Name' })
    @IsOptional()
    @IsString()
    middleName: string;

    @ApiProperty({ description: 'Last Name' })
    @IsOptional()
    @IsString()
    lastName: string;

    @ApiProperty({ description: 'Deposit Date' })
    @IsOptional()
    depositDate: Date;

    @ApiProperty({ description: 'Amount (Installment)' })
    @IsOptional()
    @IsNumber()
    amount: number;

    @ApiProperty({ description: 'Interest Rate' })
    @IsOptional()
    @IsNumber()
    rate: number;

    @ApiProperty({ description: 'Deposit Period' })
    @IsOptional()
    @IsNumber()
    depositPeriod: number;

    @ApiProperty({ description: 'Deposit Unit (1=Months, 2=Years)' })
    @IsOptional()
    @IsNumber()
    depositUnit: number;

    @ApiProperty({ description: 'Maturity Date' })
    @IsOptional()
    maturityDate: Date;

    @ApiProperty({ description: 'Maturity Amount' })
    @IsOptional()
    @IsNumber()
    maturityAmount: number;

    @ApiProperty({ description: 'Nominee Name' })
    @IsOptional()
    @IsString()
    nominee: string;

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

    @ApiProperty({ description: 'Special Instructions' })
    @IsOptional()
    @IsString()
    specialInstructions: string;
}

export class UpdateRdAccountDto extends CreateRdAccountDto { }
