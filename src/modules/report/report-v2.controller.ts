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
} from './services-v2';

/**
 * Report V2 Controller - Restructured endpoints using separated services.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * All routes are prefixed with /v2/reports to run alongside original routes.
 * After migration is complete, these will replace the original routes.
 */
@ApiTags('Reports')
@Controller('report')
export class ReportV2Controller {
    constructor(
        private readonly cashBookReports: CashBookReportsService,
        private readonly memberReports: MemberReportsService,
        private readonly loanReports: LoanReportsService,
        private readonly dividendReports: DividendReportsService,
        private readonly depositReports: DepositReportsService,
        private readonly utilityReports: UtilityReportsService,
    ) { }

    // ==================== Cash Book Reports ====================

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

    @Post('voters-list')
    @ApiOperation({ summary: 'Get voters list' })
    async getVotersList(@Body() dto: { wingNo?: string; officeNo?: string; limit?: number; offset?: number }) {
        return this.memberReports.getVotersList(dto);
    }

    @Post('member/balance-range')
    @ApiOperation({ summary: 'Get members by balance range' })
    async getMemberBalanceRange(@Body() dto: { minBalance: number; maxBalance: number; limit?: number; offset?: number }) {
        return this.memberReports.getMemberBalanceRangeReport(dto);
    }

    @Post('jotting')
    @ApiOperation({ summary: 'Get jotting report' })
    async getJottingReport(@Body() dto: { wingNo?: string; officeNo?: string; loanType?: string; limit?: number; offset?: number }) {
        return this.memberReports.getJottingReport(dto);
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

    @Post('member/loan-ledger')
    @ApiOperation({ summary: 'Get member loan ledger' })
    async getMemberLoanLedger(@Body() dto: { memberNo: string; loanCaseNo?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
        return this.loanReports.getMemberLoanLedger(dto);
    }

    @Post('member/loan-detail')
    @ApiOperation({ summary: 'Get member loan details' })
    async getMemberLoanDetail(@Body() dto: { memberNo?: string; loanType?: string; limit?: number; offset?: number }) {
        return this.loanReports.getMemberLoanDetail(dto);
    }

    @Post('surety-register')
    @ApiOperation({ summary: 'Get surety register' })
    async getSuretyRegister(@Body() dto: { memberNo?: string; limit?: number; offset?: number }) {
        return this.loanReports.getSuretyRegister(dto);
    }

    @Get('loan-types')
    @ApiOperation({ summary: 'Get loan types' })
    async getLoanTypes() {
        return this.loanReports.getLoanTypes();
    }

    // ==================== Dividend Reports ====================

    @Post('dividend')
    @ApiOperation({ summary: 'Get dividend report' })
    async getDividendReport(@Body() dto: { year: number; wingNo?: string; officeNo?: string; limit?: number; offset?: number }) {
        return this.dividendReports.getDividendReport(dto);
    }

    @Post('dividend/paid')
    @ApiOperation({ summary: 'Get dividend paid report' })
    async getDividendPaid(@Body() dto: { year: number; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
        return this.dividendReports.getDividendPaid(dto);
    }

    @Post('dividend/warrant')
    @ApiOperation({ summary: 'Get dividend warrant' })
    async getDividendWarrant(@Body() dto: { memberNo: string; year: number }) {
        return this.dividendReports.getDividendWarrant(dto);
    }

    @Get('share/warrant/:memberNo')
    @ApiOperation({ summary: 'Get share warrant' })
    async getShareWarrant(@Param('memberNo') memberNo: string) {
        return this.dividendReports.getShareWarrant({ memberNo });
    }

    @Post('interest-list')
    @ApiOperation({ summary: 'Get interest list' })
    async getInterestList(@Body() dto: { year: number; type?: string; limit?: number; offset?: number }) {
        return this.dividendReports.getInterestList(dto);
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

    @Get('fd/certificate/:accountNo')
    @ApiOperation({ summary: 'Get FD certificate' })
    async getFDCertificate(@Param('accountNo') accountNo: string) {
        return this.depositReports.getFixedDepositCertificate({ accountNo });
    }

    @Get('share/certificate/:memberNo')
    @ApiOperation({ summary: 'Get share certificate' })
    async getShareCertificate(@Param('memberNo') memberNo: string) {
        return this.depositReports.getShareCertificate({ memberNo });
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

    @Post('financial-summary')
    @ApiOperation({ summary: 'Get financial summary' })
    async getFinancialSummary(@Body() dto: { fromDate: string; toDate: string }) {
        return this.utilityReports.getFinancialSummary(dto);
    }

    @Post('account-closing')
    @ApiOperation({ summary: 'Get account closing register' })
    async getAccountClosingRegister(@Body() dto: { fromDate: string; toDate: string; accountType?: string }) {
        return this.utilityReports.getAccountClosingRegister(dto);
    }

    @Post('recovery-details')
    @ApiOperation({ summary: 'Get recovery details' })
    async getRecoveryDetails(@Body() dto: { month: string; year: number; wingNo?: string }) {
        return this.utilityReports.getRecoveryDetails(dto);
    }

    @Get('diagnostic')
    @ApiOperation({ summary: 'Run diagnostic check' })
    async diagnosticCheck() {
        return this.utilityReports.diagnosticCheck();
    }
}
