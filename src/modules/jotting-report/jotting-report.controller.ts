import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JottingReportService } from './jotting-report.service';

@ApiTags('Jotting Report')
@Controller('jotting-report')
export class JottingReportController {
  constructor(private readonly jottingReportService: JottingReportService) {}

  @ApiOperation({ summary: 'List account head masters (for jotting-report head dropdown)' })
  @Get('head-masters')
  async getHeadMasters() {
    return this.jottingReportService.getHeadMasters();
  }

  @ApiOperation({ summary: 'List wings (for jotting-report wing filter)' })
  @Get('wings')
  async getWingList() {
    return this.jottingReportService.getWingList();
  }

  @ApiOperation({ summary: 'List offices (for jotting-report office filter)' })
  @Get('offices')
  async getOfficeList() {
    return this.jottingReportService.getOfficeList();
  }

  @ApiOperation({ summary: 'Generate the jotting report (head balances as-on-date, by wing/office)' })
  @Get()
  async getJottingReport(
    @Query('headCode') headCode: string,
    @Query('asOnDate') asOnDate: string,
    @Query('wingName') wingName?: string,
    @Query('officeName') officeName?: string,
    @Query('sortBy') sortBy?: string,
  ) {
    return this.jottingReportService.getJottingReport({
      headCode,
      asOnDate,
      wingName,
      officeName,
      sortBy,
    });
  }
}