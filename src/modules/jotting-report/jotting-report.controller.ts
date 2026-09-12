import { Controller, Get, Query } from '@nestjs/common';
import { JottingReportService } from './jotting-report.service';

@Controller('jotting-report')
export class JottingReportController {
  constructor(private readonly jottingReportService: JottingReportService) {}

  @Get('head-masters')
  async getHeadMasters() {
    return this.jottingReportService.getHeadMasters();
  }

  @Get('wings')
  async getWingList() {
    return this.jottingReportService.getWingList();
  }

  @Get('offices')
  async getOfficeList() {
    return this.jottingReportService.getOfficeList();
  }

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