import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsNotEmpty } from 'class-validator';

export class BulkUpdateBusinessRulesDto {
    @ApiProperty({
        description: 'Object containing key-value pairs of business rules to update',
        example: { 'RULE_LOAN_R_MAX_AMT': '150000', 'SYS_DATA_ENTRY_MODE': true }
    })
    @IsObject()
    @IsNotEmpty()
    rules: Record<string, any>;
}
