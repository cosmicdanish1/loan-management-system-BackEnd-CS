import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LedgerPostingService, LedgerSummaryDto, LedgerPostingDto } from './services-v2/ledger-posting.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Transaction - Ledger Posting')
@Controller('transactions/ledger-posting')
@UseGuards(JwtAuthGuard)
export class LedgerPostingController {
    constructor(private readonly service: LedgerPostingService) { }

    @Get('summary')
    @ApiOperation({ summary: 'Get ledger posting summary for a period' })
    async getSummary(@Query('month') month: string, @Query('year') year: string, @Query('branch') branch: string) {
        return this.service.getSummary({ month, year, branch });
    }

    @Post('post')
    @ApiOperation({ summary: 'Post updates to General Ledger' })
    @ApiResponse({ status: 200, description: 'Ledger updated successfully' })
    async postUpdate(@Body() dto: LedgerPostingDto) {
        return this.service.postUpdate(dto);
    }
}
