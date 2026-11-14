import { RequireMenuAction } from '../../auth/guards/menu-right.guard';
import { Controller, Get, Post, Body, Query, Req, ParseIntPipe, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DividendCreditService } from '../services/dividend-credit.service';

@ApiTags('Dividend - Credit')
@Controller('dividend/credit')
export class DividendCreditController {
    constructor(private readonly service: DividendCreditService) {}

    @Get('preview')
    @ApiOperation({ summary: "Read-only preview of the prior financial year's dividend that would be credited to Share Value at this year's close — writes nothing" })
    async preview(@Query('yearcode', ParseIntPipe) yearcode: number) {
        return this.service.previewCreditForYear(yearcode);
    }

    @RequireMenuAction('RECEIPT_DIVIDEND_PAYMENT', 'DIVIDEND_PAID', 'FIN_YEAR_CLOSING') // ES-464
    @Post('commit')
    @ApiOperation({ summary: "Credits every member's eligible prior-year dividend into their Share Value" })
    async commit(@Body() body: { yearcode: number; creditedBy?: string }, @Req() req: any) {
        if (!body?.yearcode) throw new BadRequestException('yearcode is required.');
        return this.service.creditAllForYear(Number(body.yearcode), req?.user?.username || 'system' /* ES-464: from the token */);
    }
}
