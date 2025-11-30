import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn } from 'class-validator';
import { CreateLoanDto } from './create-loan.dto';

export class UpdateLoanDto extends PartialType(CreateLoanDto) {
  @ApiProperty({
    description: 'Loan status',
    example: 'ACTIVE',
    enum: ['ACTIVE', 'CLOSED', 'DEFAULTED', 'WRITTEN_OFF'],
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'CLOSED', 'DEFAULTED', 'WRITTEN_OFF'])
  status?: string;
}
