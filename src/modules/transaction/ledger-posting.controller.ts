import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LedgerPostingService, LedgerPostingDto } from './services-v2/ledger-posting.service';

@ApiTags('Transaction - Ledger Posting')
@Controller('transactions/ledger-posting')
export class LedgerPostingController {
    constructor(private readonly service: LedgerPostingService) { }

    @Get('summary')
    @ApiOperation({ summary: 'Get member-wise demand summary for ledger posting' })
    async getSummary(
        @Query('month') month: string,
        @Query('year') year: string,
        @Query('branch') branch: string,
        @Query('fromMember') fromMember?: string,
        @Query('toMember') toMember?: string,
    ) {
        return this.service.getSummary({ month, year, branch, fromMember, toMember });
    }

    @Post('post')
    @ApiOperation({ summary: 'Post demand recovery to General Ledger' })
    @ApiResponse({ status: 200, description: 'Ledger updated successfully' })
    async postUpdate(@Body() dto: LedgerPostingDto) {
        return this.service.postUpdate(dto);
    }
}
