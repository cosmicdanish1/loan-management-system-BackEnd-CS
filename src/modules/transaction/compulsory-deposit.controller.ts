import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { CompulsoryDepositService } from './services-v2/compulsory-deposit.service';
import { PostCDTransactionDto } from './dto/compulsory-deposit.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Compulsory Deposit Transactions')
@Controller('transactions/cd')
export class CompulsoryDepositController {
    constructor(private readonly cdService: CompulsoryDepositService) { }

    @Get('members')
    @ApiOperation({ summary: 'Get list of members for CD transaction matrix' })
    async getMembers() {
        return this.cdService.getCDAccountList();
    }

    @Get('income-heads')
    @ApiOperation({ summary: 'Get Income Ledger heads from main table' })
    async getIncomeHeads() {
        return this.cdService.getIncomeHeads();
    }

    @Post('post')
    @ApiOperation({ summary: 'Execute bulk CD interest/incentive posting' })
    async postCD(@Body() dto: PostCDTransactionDto, @Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.cdService.postCDInterestAction(dto, username);
    }
}
