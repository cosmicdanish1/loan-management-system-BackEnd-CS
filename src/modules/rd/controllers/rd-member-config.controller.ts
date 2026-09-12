import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RdMemberConfigService } from '../services/rd-member-config.service';

@ApiTags('RD - Member Config')
@Controller('rd/member-config')
@UseGuards(JwtAuthGuard)
export class RdMemberConfigController {
    constructor(private readonly service: RdMemberConfigService) { }

    @Post(':mbno/:yearcode')
    @ApiOperation({ summary: "Set a member's monthly RD amount for a financial year" })
    async setMonthlyAmount(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Body() body: { monthlyRdAmount: number; setBy?: string },
    ) {
        await this.service.setMonthlyAmount(mbno, yearcode, Number(body.monthlyRdAmount), body.setBy || 'system');
        // No manual {success,data} wrapper here -- the global
        // TransformInterceptor (main.ts) already wraps every controller's
        // return value in {success,statusCode,message,data,timestamp}.
        // Wrapping again here double-nests the payload one level too deep
        // for the frontend's single-level unwrap (confirmed live: this
        // exact pattern broke RD Member Setup's history table).
        return { message: 'Monthly RD amount saved.' };
    }

    @Get(':mbno/:yearcode/current')
    @ApiOperation({ summary: "The member's currently-effective monthly RD amount for a financial year" })
    async getCurrentAmount(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Query('asOfDate') asOfDate?: string,
    ) {
        const amount = await this.service.getCurrentAmount(
            mbno, yearcode, asOfDate ? new Date(asOfDate) : undefined,
        );
        return { monthlyRdAmount: amount };
    }

    @Get(':mbno/:yearcode/history')
    @ApiOperation({ summary: "A member's monthly RD amount change history for a financial year" })
    async getHistory(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
    ) {
        return this.service.getHistory(mbno, yearcode);
    }
}
