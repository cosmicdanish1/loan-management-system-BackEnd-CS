import { RequireMenuAction } from '../../auth/guards/menu-right.guard';
import { BadRequestException, Controller, Get, Post, Body, Param, Req, UseGuards, ParseIntPipe } from '@nestjs/common';
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
        const [balance, totalHoldings, maxWithdrawable, lockedAmount] = await Promise.all([
            this.service.getCurrentBalance(mbno, yearcode),
            this.service.getTotalCurrentHoldings(mbno, yearcode),
            this.service.getMaxWithdrawable(mbno, yearcode),
            this.service.getLockedAmount(mbno),
        ]);
        // lockedAmount: RD held as security for a Loan Against RD — part of
        // totalHoldings, but not withdrawable until that loan closes.
        return { balance, totalHoldings, maxWithdrawable, lockedAmount };
    }

    @Get(':mbno/:yearcode/timeline')
    @ApiOperation({ summary: "A member's full RD balance-event timeline for a financial year" })
    async getTimeline(@Param('mbno') mbno: string, @Param('yearcode', ParseIntPipe) yearcode: number) {
        return this.service.getTimeline(mbno, yearcode);
    }

    @RequireMenuAction('RD_AC_OPENING', 'PASS_RD_AC') // ES-464
    @Post(':mbno/:yearcode/withdraw')
    @ApiOperation({ summary: "Withdraw from a member's RD balance, enforcing the configured minimum" })
    async withdraw(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Body() body: { amount: number; narration?: string; createdBy?: string; asOfDate?: string },
        @Req() req: any,
    ) {
        // ES-579: the acting user is the logged-in user, never a name sent in the body (that one used to default to "system")
        const username = String(req.user?.username || body.createdBy || '').trim();
        if (!username) throw new BadRequestException('The logged-in user could not be identified.');
        const result = await this.service.withdrawAndPost(
            mbno, yearcode, Number(body.amount),
            body.asOfDate ? new Date(body.asOfDate) : new Date(),
            username,
            body.narration,
        );
        const parts: string[] = [];
        if (result.fromOpeningPot > 0) parts.push(`₹${result.fromOpeningPot.toLocaleString('en-IN')} from the opening-balance pot`);
        if (result.fromInstallments > 0) parts.push(`₹${result.fromInstallments.toLocaleString('en-IN')} from paid installments`);
        const split = parts.length ? ` (${parts.join(' + ')})` : '';
        return {
            message: `Withdrawal recorded${split}. Voucher ${result.voucherNo}. RD/CD balance now ₹${result.newBalance.toLocaleString('en-IN')}.`,
            ...result,
        };
    }
}
