import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DividendPaymentService } from './services-v2/dividend-payment.service';

@ApiTags('Transactions')
@Controller('transactions/dividend')
export class DividendPaymentController {
    constructor(private readonly dividendPaymentService: DividendPaymentService) { }

    @Get('pending/:memberNo')
    @ApiOperation({ summary: 'Get pending dividends for a member' })
    async getPendingDividends(@Param('memberNo') memberNo: string) {
        return this.dividendPaymentService.getPendingDividends(memberNo);
    }

    @Post('pay')
    @ApiOperation({ summary: 'Process dividend payment' })
    async processDividendPayment(@Body() dto: any) {
        return this.dividendPaymentService.processDividendPayment(dto);
    }
}
