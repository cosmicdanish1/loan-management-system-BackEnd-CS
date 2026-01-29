import { IsNumber, IsOptional, IsString, IsDate } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFdAccountDto {
    @ApiProperty({ description: 'Member Number' })
    @IsOptional()
    @IsNumber()
    memberNo?: number;

    @ApiProperty({ description: 'Prefix' })
    @IsOptional()
    @IsString()
    prefix?: string;

    @ApiProperty({ description: 'First Name' })
    @IsOptional()
    @IsString()
    firstName?: string;

    @ApiProperty({ description: 'Middle Name' })
    @IsOptional()
    @IsString()
    middleName?: string;

    @ApiProperty({ description: 'Last Name' })
    @IsOptional()
    @IsString()
    lastName?: string;

    @ApiProperty({ description: 'Certificate Number' })
    @IsOptional()
    @IsString()
    certificateNo?: string;

    @ApiProperty({ description: 'Deposit Unit' })
    @IsOptional()
    @IsNumber()
    depositUnit?: number;

    @ApiProperty({ description: 'Deposit Period' })
    @IsOptional()
    @IsNumber()
    depositPeriod?: number;

    @ApiProperty({ description: 'Interest Rate' })
    @IsOptional()
    @IsNumber()
    rate?: number;

    @ApiProperty({ description: 'Deposit Date' })
    @IsOptional()
    @Type(() => Date)
    @IsDate()
    depositDate?: Date;

    @ApiProperty({ description: 'Maturity Date' })
    @IsOptional()
    @Type(() => Date)
    @IsDate()
    maturityDate?: Date;

    @ApiProperty({ description: 'FD Amount' })
    @IsOptional()
    @IsNumber()
    fdAmount?: number;

    @ApiProperty({ description: 'Maturity Amount' })
    @IsOptional()
    @IsNumber()
    maturityAmount?: number;

    @ApiProperty({ description: 'Interest Balance' })
    @IsOptional()
    @IsNumber()
    interestBalance?: number;

    @ApiProperty({ description: 'Interest Amount' })
    @IsOptional()
    @IsNumber()
    interestAmount?: number;

    @ApiProperty({ description: 'Last Interest Payment Date' })
    @IsOptional()
    @Type(() => Date)
    @IsDate()
    lastIntPaymentDate?: Date;

    @ApiProperty({ description: 'Interest Paid' })
    @IsOptional()
    @IsNumber()
    interestPaid?: number;

    @ApiProperty({ description: 'Status' })
    @IsOptional()
    @IsString()
    status?: string;

    @ApiProperty({ description: 'Nominee Name' })
    @IsOptional()
    @IsString()
    nominee?: string;

    @ApiProperty({ description: 'Nominee Age' })
    @IsOptional()
    @IsString()
    nomineeAge?: string;

    @ApiProperty({ description: 'Nominee Address' })
    @IsOptional()
    @IsString()
    nomineeAddress?: string;

    @ApiProperty({ description: 'Nominee Relation' })
    @IsOptional()
    @IsString()
    nomineeRelation?: string;

    @ApiProperty({ description: 'Mode of Payment' })
    @IsOptional()
    @IsNumber()
    modeOfPayment?: number;
}
