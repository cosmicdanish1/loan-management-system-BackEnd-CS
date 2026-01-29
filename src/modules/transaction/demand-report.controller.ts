import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DemandReportService, DemandListFiltersDto } from './services-v2/demand-report.service';

@ApiTags('Reports - Demand List')
@Controller('transactions/reports/demand-list')
export class DemandReportController {
    constructor(private readonly service: DemandReportService) { }

    @Post('generate')
    @ApiOperation({ summary: 'Generate detailed Members Demand List' })
    @ApiResponse({ status: 200, description: 'List fetched successfully' })
    async generateReport(@Body() filters: DemandListFiltersDto) {
        return this.service.getDemandList(filters);
    }
}
