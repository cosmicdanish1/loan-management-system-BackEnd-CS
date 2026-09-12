import { Controller, Get, Post, Body, Param, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RdBalanceEventsService } from '../services/rd-balance-events.service';

@ApiTags('RD - Balance Events')
@Controller('rd/balance')
@UseGuards(JwtAuthGuard)
export class RdBalanceEventsController {
    constructor(private readonly service: RdBalanceEventsService) { }

    @Get(':mbno/:yearcode/current')
    @ApiOperation({ summary: "A member's current RD balance for a financial year" })
    async getCurrent(@Param('mbno') mbno: string, @Param('yearcode', ParseIntPipe) yearcode: number) {
        // No manual {success,data} wrapper -- see rd-member-config.controller.ts's
        // comment: the global TransformInterceptor already wraps everything
        // returned here, so wrapping again double-nests the payload.
        const [balance, totalHoldings, maxWithdrawable] = await Promise.all([
            this.service.getCurrentBalance(mbno, yearcode),
            this.service.getTotalCurrentHoldings(mbno, yearcode),
            this.service.getMaxWithdrawable(mbno, yearcode),
        ]);
        return { balance, totalHoldings, maxWithdrawable };
    }

    @Get(':mbno/:yearcode/timeline')
    @ApiOperation({ summary: "A member's full RD balance-event timeline for a financial year" })
    async getTimeline(@Param('mbno') mbno: string, @Param('yearcode', ParseIntPipe) yearcode: number) {
        return this.service.getTimeline(mbno, yearcode);
    }

    @Post(':mbno/:yearcode/withdraw')
    @ApiOperation({ summary: "Withdraw from a member's RD balance, enforcing the configured minimum" })
    async withdraw(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Body() body: { amount: number; narration?: string; createdBy?: string; asOfDate?: string },
    ) {
        const result = await this.service.recordWithdrawal(
            mbno, yearcode, Number(body.amount),
            body.asOfDate ? new Date(body.asOfDate) : new Date(),
            body.createdBy || 'system',
            body.narration,
        );
        const parts: string[] = [];
        if (result.fromOpeningPot > 0) parts.push(`₹${result.fromOpeningPot.toLocaleString('en-IN')} from the opening-balance pot`);
        if (result.fromInstallments > 0) parts.push(`₹${result.fromInstallments.toLocaleString('en-IN')} from paid installments`);
        return {
            message: `Withdrawal recorded (${parts.join(' + ')}). Remaining total holdings: ₹${result.remainingTotalHoldings.toLocaleString('en-IN')}.`,
            ...result,
        };
    }
}
