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
import { JottingReportDto } from './dto/jotting-report.dto';
import { MemberBalanceRangeDto } from './dto/member-balance-range.dto';
import { SavingStatementDto } from './dto/saving-statement.dto';
import { RDStatementDto } from './dto/rd-statement.dto';
import { FDStatementDto } from './dto/fd-statement.dto';
import { MemberStatementDto } from './dto/member-statement.dto';
import { MemberProfileDto } from './dto/member-profile.dto';
import { InterestCertificateDto } from './dto/interest-certificate.dto';
import { LoanNilCertificateDto } from './dto/loan-nil-certificate.dto';
import { SuretyRegisterDto } from './dto/surety-register.dto';
import { DepositMaturityDto } from './dto/deposit-maturity.dto';
import { AccountClosingRegisterDto } from './dto/account-closing-register.dto';
import { FixedDepositCertificateDto } from './dto/fixed-deposit-certificate.dto';
import { ShareCertificateDto } from './dto/share-certificate.dto';
import { RecurringDetailsDto } from './dto/recurring-details.dto';
import { RecoveryDetailsDto } from './dto/recovery-details.dto';
import { LoanContributionsRegisterDto } from './dto/loan-contributions-register.dto';
import { LienAccountInformationDto } from './dto/lien-account-information.dto';
import { AdHocReportsDto } from './dto/adhoc-reports.dto';
import { PassBookPrintingDto } from './dto/passbook-printing.dto';

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

  @Get('jotting')
  getJottingReport(@Query() query: JottingReportDto) {
    return this.reportService.getJottingReport(query);
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

  @Get('wing-list')
  getWingList() {
    return this.reportService.getWingList();
  }

  @Get('office-list')
  getOfficeList() {
    return this.reportService.getOfficeList();
  }

  @Get('member-balance-range')
  getMemberBalanceRangeReport(@Query() query: MemberBalanceRangeDto) {
    return this.reportService.getMemberBalanceRangeReport(query);
  }

  @Get('schedule')
  getAllSchedules(@Query('type') type?: string) {
    return this.reportService.getAllReportSchedules(type);
  }

  @Get()
  async findAll() {
    return { message: 'Report endpoints - To be implemented' };
  }
  @Get('saving-statement')
  getSavingStatement(@Query() query: SavingStatementDto) {
    return this.reportService.getSavingStatement(query);
  }
  @Get('rd-statement')
  getRDStatement(@Query() query: RDStatementDto) {
    return this.reportService.getRDStatement(query);
  }

  @Get('fd-statement')
  getFDStatement(@Query() query: FDStatementDto) {
    return this.reportService.getFDStatement(query);
  }

  @Get('member-statement')
  getMemberStatement(@Query() query: MemberStatementDto) {
    return this.reportService.getMemberStatement(query);
  }

  @Get('member-profile')
  getMemberProfile(@Query() query: MemberProfileDto) {
    return this.reportService.getMemberProfile(query);
  }

  @Get('interest-certificate')
  getInterestCertificate(@Query() query: InterestCertificateDto) {
    return this.reportService.getInterestCertificate(query);
  }

  @Get('loan-nil-certificate')
  getLoanNilCertificate(@Query() query: LoanNilCertificateDto) {
    return this.reportService.getLoanNilCertificate(query);
  }

  @Get('surety-register')
  getSuretyRegister(@Query() query: SuretyRegisterDto) {
    return this.reportService.getSuretyRegister(query);
  }

  @Get('deposit-maturity')
  getDepositMaturity(@Query() query: DepositMaturityDto) {
    return this.reportService.getDepositMaturity(query);
  }

  @Get('account-closing')
  getAccountClosingRegister(@Query() query: AccountClosingRegisterDto) {
    return this.reportService.getAccountClosingRegister(query);
  }

  @Get('fd-certificate')
  getFixedDepositCertificate(@Query() query: FixedDepositCertificateDto) {
    return this.reportService.getFixedDepositCertificate(query);
  }

  @Get('share-certificate')
  getShareCertificate(@Query() query: ShareCertificateDto) {
    return this.reportService.getShareCertificate(query);
  }

  @Get('recurring-details')
  getRecurringDetails(@Query() query: RecurringDetailsDto) {
    return this.reportService.getRecurringDetails(query);
  }

  @Get('recovery-details')
  getRecoveryDetails(@Query() query: RecoveryDetailsDto) {
    return this.reportService.getRecoveryDetails(query);
  }

  @Get('loan-contributions-register')
  getLoanContributionsRegister(@Query() query: LoanContributionsRegisterDto) {
    return this.reportService.getLoanContributionsRegister(query);
  }

  @Get('lien-account-information')
  getLienAccountInformation(@Query() query: LienAccountInformationDto) {
    return this.reportService.getLienAccountInformation(query);
  }

  @Get('adhoc-reports')
  getAdHocReports(@Query() query: AdHocReportsDto) {
    return this.reportService.getAdHocReports(query);
  }

  @Get('passbook-printing')
  getPassBookPrinting(@Query() query: PassBookPrintingDto) {
    return this.reportService.getPassBookPrinting(query);
  }

  @Get('diagnostic-tables')
  diagnosticCheck() {
    return this.reportService.diagnosticCheck();
  }
}
