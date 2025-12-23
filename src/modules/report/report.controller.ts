import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReportService } from './report.service';
import { CashBookMonthlyDto } from './dto/cash-book-monthly.dto';
import { DetailLedgerDto } from './dto/detail-ledger.dto';
import { BankDetailLedgerDto } from './dto/bank-detail-ledger.dto';
import { DefaulterListDto } from './dto/defaulter-list.dto';
import { NewLoanDisbursedDto } from './dto/new-loan-disbursed.dto';
import { MemberLoanLedgerDto } from './dto/member-loan-ledger.dto';
import { FinancialSummaryDto } from './dto/financial-summary.dto';
import { VotersListDto } from './dto/voters-list.dto';
import { DividendReportDto } from './dto/dividend-report.dto';
import { DividendPaidDto } from './dto/dividend-paid.dto';
import { InterestListDto } from './dto/interest-list.dto';
import { DividendWarrantDto } from './dto/dividend-warrant.dto';
import { CreateReportScheduleDto } from './dto/create-report-schedule.dto';
import { ExecuteReportScheduleDto } from './dto/execute-report-schedule.dto';

@ApiTags('Reports')
@Controller('report')
export class ReportController {
  constructor(private readonly reportService: ReportService) { }

  @Get('cash-book-monthly')
  getCashBookMonthly(@Query() query: CashBookMonthlyDto) {
    return this.reportService.getCashBookMonthly(query);
  }

  @Get('detail-ledger')
  getDetailLedger(@Query() query: DetailLedgerDto) {
    return this.reportService.getDetailLedger(query);
  }

  @Get('head-list')
  getHeadList() {
    return this.reportService.getHeadList();
  }

  @Get('bank-list')
  getBankList() {
    return this.reportService.getBankList();
  }

  @Get('bank-detail-ledger')
  getBankDetailLedger(@Query() query: BankDetailLedgerDto) {
    return this.reportService.getBankDetailLedger(query);
  }

  @Get('defaulter-list')
  getDefaulterList(@Query() query: DefaulterListDto) {
    return this.reportService.getDefaulterList(query);
  }

  @Get('loan-types')
  getLoanTypes() {
    return this.reportService.getLoanTypes();
  }

  @Get('new-loan-disbursed')
  getNewLoanDisbursed(@Query() query: NewLoanDisbursedDto) {
    return this.reportService.getNewLoanDisbursed(query);
  }

  @Get('member-loan-ledger')
  getMemberLoanLedger(@Query() query: MemberLoanLedgerDto) {
    return this.reportService.getMemberLoanLedger(query);
  }

  @Get('financial-summary')
  getFinancialSummary(@Query() query: FinancialSummaryDto) {
    return this.reportService.getFinancialSummary(query);
  }

  @Get('voters-list')
  getVotersList(@Query() query: VotersListDto) {
    return this.reportService.getVotersList(query);
  }

  @Get('dividend-report')
  getDividendReport(@Query() query: DividendReportDto) {
    return this.reportService.getDividendReport(query);
  }

  @Get('dividend-paid')
  getDividendPaid(@Query() query: DividendPaidDto) {
    return this.reportService.getDividendPaid(query);
  }

  @Get('interest-list')
  getInterestList(@Query() query: InterestListDto) {
    return this.reportService.getInterestList(query);
  }

  @Get('dividend-warrant')
  getDividendWarrant(@Query() query: DividendWarrantDto) {
    return this.reportService.getDividendWarrant(query);
  }

  // Report Schedule Builder Endpoints
  @Post('schedule')
  createReportSchedule(@Body() dto: CreateReportScheduleDto) {
    return this.reportService.createReportSchedule(dto);
  }

  @Post('schedule/execute')
  executeReportSchedule(@Body() dto: ExecuteReportScheduleDto) {
    return this.reportService.executeReportSchedule(dto);
  }

  @Get('schedule')
  getAllSchedules(@Query('type') type?: string) {
    return this.reportService.getAllReportSchedules(type);
  }

  @Get()
  async findAll() {
    return { message: 'Report endpoints - To be implemented' };
  }
}
