
import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MemberBalanceRangeDto {
    @ApiProperty({ description: 'Starting Member Account Number' })
    @IsNotEmpty()
    @IsString()
    fromAccountNo: string;

    @ApiProperty({ description: 'Ending Member Account Number' })
    @IsNotEmpty()
    @IsString()
    toAccountNo: string;
}
