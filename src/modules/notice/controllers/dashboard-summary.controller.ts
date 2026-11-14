import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DashboardSummaryService } from '../services/dashboard-summary.service';

@ApiTags('Dashboard Summary')
@Controller('dashboard-summary')
export class DashboardSummaryController {
    constructor(private readonly summary: DashboardSummaryService) { }

    @ApiOperation({ summary: 'Figures for the dashboard widgets (deposits, maturities, applications, members, demand)' })
    @Get()
    async getSummary() {
        return this.summary.getSummary();
    }

    @ApiOperation({ summary: 'Cash-In-Hand opening / receipts / payments / closing per day for the last N days (default 7), in one query' })
    @Get('cash-trend')
    async getCashTrend(@Query('days') days?: string) {
        return this.summary.getCashTrend(days ? Number(days) : 7);
    }
}
