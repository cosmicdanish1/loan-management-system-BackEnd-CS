import { RequireMenuAction } from '../../auth/guards/menu-right.guard';
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RdFinancialYearClosingService, AuthorityOverride } from '../services/rd-financial-year-closing.service';

interface CloseMemberBody {
    closedBy: string;
    overrideEligible?: boolean;
    overrideReason?: string;
}

interface CloseAllBody {
    closedBy: string;
    /** Authority overrides identified on the bulk-review screen, keyed by
     *  member number — exception-only, per the user's spec: most members
     *  close with no entry here at all, using the pattern engine's verdict. */
    overrides?: Record<string, { eligible: boolean; reason: string }>;
}

@ApiTags('RD - Financial Year Closing')
@Controller('rd/closing')
@UseGuards(JwtAuthGuard)
export class RdFinancialYearClosingController {
    constructor(private readonly service: RdFinancialYearClosingService) { }

    @Get(':yearcode/members')
    @ApiOperation({ summary: 'Every member with RD activity in a financial year (candidates for closing)' })
    async listMembers(@Param('yearcode', ParseIntPipe) yearcode: number) {
        // No manual {success,data} wrapper anywhere in this controller -- the
        // global TransformInterceptor already adds one; see
        // rd-member-config.controller.ts's comment for why double-wrapping
        // broke the frontend (confirmed live).
        return this.service.listMembersWithActivity(yearcode);
    }

    @Get(':yearcode/preview')
    @ApiOperation({ summary: 'Bulk read-only preview of what closing this year would produce, for the review screen' })
    async previewAll(
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        return this.service.previewFinancialYearClosing(
            yearcode,
            limit ? Number(limit) : 200,
            offset ? Number(offset) : 0,
        );
    }

    @Get(':mbno/:yearcode/preview')
    @ApiOperation({ summary: "One member's read-only closing preview" })
    async previewOne(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Query('overrideEligible') overrideEligible?: string,
    ) {
        const override = overrideEligible === undefined ? undefined : overrideEligible === 'true';
        return this.service.previewMemberClosing(mbno, yearcode, override);
    }

    @Get('history/years')
    @ApiOperation({ summary: 'ES-629: past financial years that have RD/CD money in the ledger (read-only history)' })
    async historyYears() {
        return this.service.listHistoryYears();
    }

    @Get(':mbno/history/:fyStartYear/explain')
    @ApiOperation({ summary: "ES-629: a PAST financial year's RD/CD interest of one member, worked out from the ledger, with what the legacy posted (read-only)" })
    async explainHistory(@Param('mbno') mbno: string, @Param('fyStartYear', ParseIntPipe) fyStartYear: number) {
        return this.service.explainHistoryYear(mbno, fyStartYear);
    }

    @Get(':mbno/:yearcode/explain')
    @ApiOperation({ summary: "ES-629: one member's month-by-month RD/CD interest calculation, pattern and decision (read-only)" })
    async explainOne(@Param('mbno') mbno: string, @Param('yearcode', ParseIntPipe) yearcode: number) {
        return this.service.explainMember(mbno, yearcode);
    }

    @RequireMenuAction('FIN_YEAR_CLOSING', 'RD_INTEREST')
    @Post(':mbno/:yearcode/decision')
    @ApiOperation({ summary: "ES-629: record the employee's Allow / Deny of the full interest for one member's year" })
    async decide(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Body() body: { decision: 'ALLOW' | 'DENY'; reason?: string },
        @Req() req: any,
    ) {
        const by = req?.user?.username || 'system'; // from the token, never from the body
        return this.service.setDecision(mbno, yearcode, body?.decision, body?.reason ?? '', by);
    }

    @RequireMenuAction('FIN_YEAR_CLOSING', 'RD_INTEREST')
    @Post(':mbno/:yearcode/decision/clear')
    @ApiOperation({ summary: 'ES-629: take back the decision of one member (back to the default)' })
    async clearDecision(@Param('mbno') mbno: string, @Param('yearcode', ParseIntPipe) yearcode: number) {
        return this.service.clearDecision(mbno, yearcode);
    }

    @RequireMenuAction('FIN_YEAR_CLOSING', 'RD_INTEREST') // ES-464
    @Post(':mbno/:yearcode/close')
    @ApiOperation({ summary: "Close one member's RD financial year — credits interest, writes the audit summary, rolls the balance forward" })
    async closeOne(
        @Param('mbno') mbno: string,
        @Param('yearcode', ParseIntPipe) yearcode: number,
        @Body() body: CloseMemberBody,
        @Req() req: any,
    ) {
        const closedBy = req?.user?.username || 'system'; // ES-464: from the token, not the body
        const override: AuthorityOverride | undefined =
            body.overrideEligible === undefined
                ? undefined
                : { eligible: body.overrideEligible, reason: body.overrideReason || 'No reason given', by: closedBy };
        return this.service.closeMemberYear(mbno, yearcode, closedBy, override);
    }

    @RequireMenuAction('FIN_YEAR_CLOSING') // ES-464
    @Post(':yearcode/close-all')
    @ApiOperation({ summary: 'Close every member with RD activity this year in one batch — failures are collected, not fatal to the batch' })
    async closeAll(@Param('yearcode', ParseIntPipe) yearcode: number, @Body() body: CloseAllBody, @Req() req: any) {
        const closedBy = req?.user?.username || 'system'; // ES-464
        const overrides: Record<string, AuthorityOverride> = {};
        for (const [mbno, o] of Object.entries(body.overrides || {})) {
            overrides[mbno] = { eligible: o.eligible, reason: o.reason, by: closedBy };
        }
        const result = await this.service.closeFinancialYear(yearcode, closedBy, overrides);
        return {
            ...result,
            message: `Closed ${result.succeeded.length} member(s); ${result.failed.length} failed.`,
        };
    }
}
