import { Controller, Get } from '@nestjs/common';
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
}
