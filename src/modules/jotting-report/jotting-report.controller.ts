import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { parseBusinessDate } from '../shared/utils/date-utils';
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
    // ES-303: bad input is a 400 with a reason, not a database error
    if (!headCode || !String(headCode).trim()) throw new BadRequestException('Head code is required.');
    if (!asOnDate) throw new BadRequestException('As-on date is required.');
    const asOn = parseBusinessDate(asOnDate, 'As-on date', 0);
    asOnDate = `${asOn.getFullYear()}-${String(asOn.getMonth() + 1).padStart(2, '0')}-${String(asOn.getDate()).padStart(2, '0')}`;
    return this.jottingReportService.getJottingReport({
      headCode,
      asOnDate,
      wingName,
      officeName,
      sortBy,
    });
  }
}