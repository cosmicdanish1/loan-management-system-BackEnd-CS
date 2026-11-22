import { RequireMenuAction } from '../auth/guards/menu-right.guard';
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

    @Get('charge-heads')
    @ApiOperation({ summary: 'Heads a CD charge can be credited to' })
    async getChargeHeads() {
        return this.cdService.getChargeHeads();
    }

    @RequireMenuAction('COMPULSORY_DEPOSIT_LEGACY')
    @Post('charge')
    @ApiOperation({ summary: "Bulk CD charge: debit each member's Compulsory Deposit, credit the head (RD/CD Transaction Legacy)" })
    async postCharge(@Body() dto: PostCDTransactionDto, @Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.cdService.postCDInterestAction(dto, username, 'charge');
    }

    @RequireMenuAction('COMPULSORY_DEPOSIT_TRANSACTION') // ES-464
    @Post('post')
    @ApiOperation({ summary: 'Execute bulk CD interest/incentive posting' })
    async postCD(@Body() dto: PostCDTransactionDto, @Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.cdService.postCDInterestAction(dto, username);
    }
}
