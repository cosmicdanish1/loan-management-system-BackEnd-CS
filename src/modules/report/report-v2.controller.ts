import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    Param,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
    CashBookReportsService,
    MemberReportsService,
    LoanReportsService,
    DividendReportsService,
    DepositReportsService,
    UtilityReportsService,
    FinancialStatementsService,
} from './services-v2';
import { FinancialSummaryDto } from './dto/financial-summary.dto';

/**
 * Report V2 Controller - Restructured endpoints using separated services.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * All routes are prefixed with /v2/reports to run alongside original routes.
 * After migration is complete, these will replace the original routes.
 */
@ApiTags('Reports')
// Accept BOTH '/reports' (REST-plural convention, matches loans/members/transactions)
// and '/report' (singular) because the frontend's API_ROUTES + api.ts call the
// singular path. Without the singular alias every report call 404s and silently
// falls back to [] (e.g. empty Bank/Code dropdowns in Loan Payment).
@Controller(['reports', 'report'])
export class ReportV2Controller {
    constructor(
        private readonly cashBookReports: CashBookReportsService,
        private readonly memberReports: MemberReportsService,
        private readonly loanReports: LoanReportsService,
        private readonly dividendReports: DividendReportsService,
        private readonly depositReports: DepositReportsService,
        private readonly utilityReports: UtilityReportsService,
        private readonly financialStatements: FinancialStatementsService,
    ) { }

    // ==================== Cash Book Reports ====================

    @Post('cashbook/daily')
    @ApiOperation({ summary: 'Get daily cash book report (voucher-wise)' })
    async getCashBookDaily(@Body() dto: { date: string }) {
        return this.cashBookReports.getCashBookDaily(dto.date);
    }

    @Post('cashbook2/daily')
    @ApiOperation({ summary: 'Get daily cash book report (head-wise from tblcashbook)' })
    async getCashBook2Daily(@Body() dto: { date: string }) {
        return this.cashBookReports.getCashBook2Daily(dto.date);
    }

    @Post('cashbook/monthly')
    @ApiOperation({ summary: 'Get monthly cash book summary' })
    async getCashBookMonthly(@Body() dto: { month: string; year: number; limit?: number; offset?: number }) {
        return this.cashBookReports.getCashBookMonthly(dto);
    }

    @Post('ledger/detail')
    @ApiOperation({ summary: 'Get detail ledger for a head code' })
    async getDetailLedger(@Body() dto: { head_code: string; from_date: string; to_date: string; limit?: number; offset?: number }) {
        return this.cashBookReports.getDetailLedger(dto);
    }

    @Post('bank/ledger')
    @ApiOperation({ summary: 'Get bank detail ledger' })
    async getBankDetailLedger(@Body() dto: { bank_head_code: string; from_date: string; to_date: string; limit?: number; offset?: number }) {
        return this.cashBookReports.getBankDetailLedger(dto);
    }

    @Get('heads')
    @ApiOperation({ summary: 'Get list of account heads' })
    async getHeadList() {
        return this.cashBookReports.getHeadList();
    }

    @Get('banks')
    @ApiOperation({ summary: 'Get list of bank accounts' })
    async getBankList() {
        return this.cashBookReports.getBankList();
    }

    // ==================== Member Reports ====================

    @Get('member/profile/:memberNo')
    @ApiOperation({ summary: 'Get member profile' })
    async getMemberProfile(@Param('memberNo') memberNo: string) {
        return this.memberReports.getMemberProfile({ memberNo });
    }

    @Post('member/statement')
    @ApiOperation({ summary: 'Get member statement' })
    async getMemberStatement(@Body() dto: { memberNo: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
        return this.memberReports.getMemberStatement(dto);
    }

    @Get('voters-list')
    @ApiOperation({ summary: 'Get voters list' })
    async getVotersList(@Query() dto: {
        division?: string;
        branch?: string;
        memberStatus?: string;
        sortBy?: string;
        search?: string;
        limit?: number;
        offset?: number
    }) {
        return this.memberReports.getVotersList(dto);
    }

    @Post('member/balance-range')
    @ApiOperation({ summary: 'Get members by balance range' })
    async getMemberBalanceRange(@Body() dto: { minBalance: number; maxBalance: number; limit?: number; offset?: number }) {
        return this.memberReports.getMemberBalanceRangeReport(dto);
    }

    @Get('member-balance-range')
    @ApiOperation({ summary: 'Get members by account number range' })
    async getMemberBalanceByMemberRange(@Query() dto: { fromAccountNo: string; toAccountNo: string }) {
        return this.memberReports.getAccountBalanceReport(dto);
    }

    @Post('jotting')
    @ApiOperation({ summary: 'Get jotting report' })
    async getJottingReport(@Body() dto: { wingNo?: string; officeNo?: string; loanType?: string; limit?: number; offset?: number }) {
        return this.memberReports.getJottingReport(dto);
    }

    @Get('member-ledger')
    @ApiOperation({ summary: 'Get member ledger' })
    async getMemberLedger(@Query() dto: { memberNo: string; fromDate: string; toDate: string; headCode?: string }) {
        return this.memberReports.getMemberLedger(dto);
    }

    @Get('annual-member-statement')
    @ApiOperation({ summary: 'Get annual member statement' })
    async getAnnualMemberStatement(@Query() dto: { wingNo?: string; officeNo?: string }) {
        return this.memberReports.getAnnualMemberStatement(dto);
    }

    @Get('yearly-member-statement')
    @ApiOperation({ summary: 'Get yearly member statement' })
    async getYearlyMemberStatement(@Query() dto: { fromDate: string; toDate: string; wingNo?: string; officeNo?: string; fromMemberNo: string; toMemberNo: string; sortBy?: string }) {
        return this.memberReports.getYearlyMemberStatement(dto);
    }

    // ==================== Loan Reports ====================

    @Post('defaulters')
    @ApiOperation({ summary: 'Get defaulter list' })
    async getDefaulterList(@Body() dto: { minBalance?: number; loanType?: string; limit?: number; offset?: number }) {
        return this.loanReports.getDefaulterList(dto);
    }

    @Post('loans/new-disbursed')
    @ApiOperation({ summary: 'Get newly disbursed loans' })
    async getNewLoanDisbursed(@Body() dto: { fromDate: string; toDate: string; loanType?: string; limit?: number; offset?: number }) {
        return this.loanReports.getNewLoanDisbursed(dto);
    }

    @Get('member/:memberNo/loan-cases')
    @ApiOperation({ summary: 'Get loan cases for a member' })
    async getMemberLoanCases(@Param('memberNo') memberNo: string) {
        return this.loanReports.getMemberLoanCases(memberNo);
    }

    @Post('member/loan-ledger')
    @ApiOperation({ summary: 'Get member loan ledger' })
    async getMemberLoanLedger(@Body() dto: { memberNo: string; loanCaseNo?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
        return this.loanReports.getMemberLoanLedger(dto);
    }

    @Get('member-loan-detail')
    @ApiOperation({ summary: 'Get member loan detail report' })
    async getMemberLoanDetail(@Query() dto: { memberFrom: string; memberTo: string; loanType?: string }) {
        return this.loanReports.getMemberLoanDetail(dto);
    }

    @Get('loan-contributions-register')
    @ApiOperation({ summary: 'Get loan contributions register' })
    async getLoanContributionsRegister(@Query() dto: { memberNo: string; fromDate: string; toDate: string }) {
        return this.loanReports.getLoanContributionsRegister(dto);
    }

    @Get('adhoc-reports')
    @ApiOperation({ summary: 'Get AdHoc reports' })
    async getAdHocReports(@Query() dto: any) {
        return this.utilityReports.getAdHocReports(dto);
    }

    @Get('surety-register')
    @ApiOperation({ summary: 'Get surety register' })
    async getSuretyRegister(@Query() dto: { memberFrom?: string; memberTo?: string; memberNo?: string; loanType?: string; limit?: number; offset?: number }) {
        return this.loanReports.getSuretyRegister(dto);
    }

    @Get('loan-types')
    @ApiOperation({ summary: 'Get loan types' })
    async getLoanTypes() {
        return this.loanReports.getLoanTypes();
    }

    @Get('loan-nil-certificate/:memberNo')
    @ApiOperation({ summary: 'Get loan nil certificate' })
    async getLoanNilCertificate(@Param('memberNo') memberNo: string) {
        return this.loanReports.getLoanNilCertificate(memberNo);
    }

    @Post('loans/interest-statement')
    @ApiOperation({ summary: 'Get interest receivable/received statement' })
    async getInterestStatement(@Body() dto: { fromMonth?: number; fromYear?: number; toMonth?: number; toYear?: number; branch?: string; fromMember?: string; toMember?: string }) {
        return this.loanReports.getInterestStatement(dto);
    }

    // ==================== Dividend Reports ====================

    // ==================== Dividend Reports ====================

    @Get('dividend-report')
    @ApiOperation({ summary: 'Get dividend report' })
    async getDividendReport(@Query() dto: { year?: string; financialYear?: string; wingName?: string; officeName?: string; dividendRate?: number; limit?: number; offset?: number; sortBy?: string }) {
        // Frontend sends financialYear like "2024-2025" or year
        const year = dto.year ? parseInt(dto.year) : (dto.financialYear ? parseInt(dto.financialYear.split('-')[0]) : new Date().getFullYear());
        const dividendRate = dto.dividendRate ? parseFloat(dto.dividendRate.toString()) : 10;
        return this.dividendReports.getDividendReport({
            year,
            wingNo: dto.wingName,
            officeNo: dto.officeName,
            dividendRate,
            limit: dto.limit,
            offset: dto.offset
        });
    }

    @Get('dividend-paid')
    @ApiOperation({ summary: 'Get dividend paid report' })
    async getDividendPaid(@Query() dto: { wingName?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
        return this.dividendReports.getDividendPaid({
            year: new Date().getFullYear(), // Placeholder, logic uses date range
            wingNo: dto.wingName,
            fromDate: dto.fromDate,
            toDate: dto.toDate,
            limit: dto.limit,
            offset: dto.offset
        });
    }

    @Get('dividend-warrant')
    @ApiOperation({ summary: 'Get dividend warrant' })
    async getDividendWarrant(@Query() dto: { wingName?: string; officeName?: string; fromDate?: string; uptoDate?: string; memberNo?: string; sortBy?: string }) {
        return this.dividendReports.getDividendWarrant({
            memberNo: dto.memberNo,
            year: dto.fromDate ? new Date(dto.fromDate).getFullYear() : new Date().getFullYear(), // Estimating year from date
            wingNo: dto.wingName,
            officeNo: dto.officeName,
            fromDate: dto.fromDate,
            toDate: dto.uptoDate
        });
    }

    @Get('interest-list')
    @ApiOperation({ summary: 'Get interest list' })
    async getInterestList(@Query() dto: { financialYear?: string; wingName?: string; accountType?: string; sortBy?: string; limit?: number; offset?: number }) {
        const year = dto.financialYear ? parseInt(dto.financialYear.split('-')[0]) : new Date().getFullYear();
        return this.dividendReports.getInterestList({
            year,
            wingNo: dto.wingName,
            type: dto.accountType,
            limit: dto.limit,
            offset: dto.offset
        });
    }

    @Get('share-warrant')
    @ApiOperation({ summary: 'Get share warrant' })
    async getShareWarrant(@Query() dto: { memberFrom: string; memberTo: string; warrantDate?: string }) {
        return this.dividendReports.getShareWarrant(dto);
    }

    @Post('interest-certificate')
    @ApiOperation({ summary: 'Get interest certificate' })
    async getInterestCertificate(@Body() dto: { memberNo: string; year: number }) {
        return this.dividendReports.getInterestCertificate(dto);
    }

    // ==================== Deposit Reports ====================

    @Post('fd/statement')
    @ApiOperation({ summary: 'Get FD statement' })
    async getFDStatement(@Body() dto: { memberNo?: string; fromDate?: string; toDate?: string }) {
        return this.depositReports.getFDStatement(dto);
    }

    @Post('rd/statement')
    @ApiOperation({ summary: 'Get RD statement' })
    async getRDStatement(@Body() dto: { memberNo?: string; fromDate?: string; toDate?: string }) {
        return this.depositReports.getRDStatement(dto);
    }

    @Post('saving/statement')
    @ApiOperation({ summary: 'Get saving statement' })
    async getSavingStatement(@Body() dto: { memberNo: string; fromDate?: string; toDate?: string }) {
        return this.depositReports.getSavingStatement(dto);
    }

    @Post('deposit/maturity')
    @ApiOperation({ summary: 'Get deposit maturity report' })
    async getDepositMaturity(@Body() dto: { fromDate: string; toDate: string; depositType?: string }) {
        return this.depositReports.getDepositMaturity(dto);
    }

    @Get('fd-certificate')
    @ApiOperation({ summary: 'Get FD certificate' })
    async getFDCertificate(@Query() dto: { memberNo: string; accountNo?: string; certificateNo?: string }) {
        return this.depositReports.getFixedDepositCertificate(dto);
    }

    @Get('share-certificate')
    @ApiOperation({ summary: 'Get share certificate' })
    async getShareCertificate(@Query() dto: { memberNo: string; certificateNo?: string }) {
        return this.depositReports.getShareCertificate(dto);
    }

    @Get('recurring-details')
    @ApiOperation({ summary: 'Get recurring details' })
    async getRecurringDetails(@Query() dto: { memberNo: string }) {
        return this.depositReports.getRecurringDetails(dto);
    }

    @Get('lien-account-information')
    @ApiOperation({ summary: 'Get lien account information' })
    async getLienAccountInformation() {
        return this.depositReports.getLienAccountInformation();
    }

    @Get('passbook-printing')
    @ApiOperation({ summary: 'Get passbook printing data' })
    async getPassBookPrinting(@Query() dto: any) {
        return this.depositReports.getPassBookPrinting(dto);
    }

    @Post('passbook-reset')
    @ApiOperation({ summary: 'Reset passbook print tracking for a member' })
    async resetPassbookPrinting(@Body() body: { memberNo: string; accountType?: string }) {
        return this.depositReports.resetPassbookPrinting(body.memberNo, body.accountType);
    }

    @Post('passbook-update-tracking')
    @ApiOperation({ summary: 'Update passbook tracking after print' })
    async updatePassbookTracking(@Body() body: { memberNo: string; accountType: string; lastLedgerId: number; lastLineNo: number }) {
        return this.depositReports.updatePassbookTracking(body.memberNo, body.accountType, body.lastLedgerId, body.lastLineNo);
    }

    // ==================== Financial Statements (Trial/BS/PL) ====================

    @Get('schedule')
    @ApiOperation({ summary: 'Get all report schedules' })
    async getAllReportSchedules(@Query('type') type?: string) {
        return this.financialStatements.getAllReportSchedules(type);
    }

    @Get('schedule/:id')
    @ApiOperation({ summary: 'Get report schedule details' })
    async getReportScheduleDetails(@Param('id') id: string) {
        return this.financialStatements.getReportScheduleDetails(parseInt(id));
    }

    @Post('schedule')
    @ApiOperation({ summary: 'Create or update report schedule' })
    async createReportSchedule(@Body() dto: {
        schedule_name: string;
        template_name: string;
        report_type: string;
        details: { particulars: string; code_from: string; code_to: string }[];
        id?: number;
    }) {
        return this.financialStatements.createReportSchedule(dto);
    }

    @Get('balance-sheet')
    @ApiOperation({ summary: 'Get Balance Sheet' })
    async getBalanceSheet(@Query('asOnDate') asOnDate?: string) {
        return this.financialStatements.getBalanceSheet(asOnDate);
    }

    @Post('schedule/execute')
    @ApiOperation({ summary: 'Execute report schedule' })
    async executeReportSchedule(@Body() dto: {
        scheduleId: number;
        fromDate: string;
        toDate: string;
        financialYearStart: string;
    }) {
        return this.financialStatements.executeReportSchedule(dto);
    }

    // ==================== Utility Reports ====================

    @Get('wings')
    @ApiOperation({ summary: 'Get wing list' })
    async getWingList() {
        return this.utilityReports.getWingList();
    }

    @Get('offices')
    @ApiOperation({ summary: 'Get office list' })
    async getOfficeList(@Query('wingNo') wingNo?: string) {
        return this.utilityReports.getOfficeList(wingNo);
    }

    @Get('divisions')
    @ApiOperation({ summary: 'Get division list' })
    async getDivisionList(@Query('wingNo') wingNo?: string) {
        return this.utilityReports.getDivisionList(wingNo);
    }

    @Get('financial-summary')
    @ApiOperation({ summary: 'Get financial summary (Trial Balance)' })
    async getFinancialSummary(@Query() dto: FinancialSummaryDto) {
        return this.utilityReports.getFinancialSummary(dto);
    }

    @Get('account-closing')
    @ApiOperation({ summary: 'Get account closing register' })
    async getAccountClosingRegister(@Query() dto: { month: number; year: number; accountType?: string }) {
        return this.utilityReports.getAccountClosingRegister(dto);
    }

    @Get('recovery-details')
    @ApiOperation({ summary: 'Get recovery details' })
    async getRecoveryDetails(@Query() dto: { memberNo: string; month: string; year: number; wingNo?: string }) {
        return this.utilityReports.getRecoveryDetails(dto);
    }

    @Get('diagnostic')
    @ApiOperation({ summary: 'Run diagnostic check' })
    async diagnosticCheck() {
        return this.utilityReports.diagnosticCheck();
    }
}
