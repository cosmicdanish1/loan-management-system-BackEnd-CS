import {
    Controller,
    Get,
    Post,
    Patch,
    Body,
    Param,
    Query,
    BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { parseSafeDate } from '../shared/utils/date-utils';
import {
    LoanApplicationService,
    LoanSanctionService,
    LoanSuretyService,
    LoanQueryService,
    LoanRepaymentService,
    LoanMonthEndService,
} from './services-v2';

/**
 * Loan V2 Controller - Restructured endpoints using separated services.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * All routes are prefixed with /v2/loans to run alongside original routes.
 * After migration is complete, these will replace the original routes.
 */
@ApiTags('Loans')
@Controller('loans')
export class LoanV2Controller {
    constructor(
        private readonly loanApplicationService: LoanApplicationService,
        private readonly loanSanctionService: LoanSanctionService,
        private readonly loanSuretyService: LoanSuretyService,
        private readonly loanQueryService: LoanQueryService,
        private readonly loanRepaymentService: LoanRepaymentService,
        private readonly loanMonthEndService: LoanMonthEndService,
    ) { }

    // ==================== Application Operations ====================

    @Get('cases')
    @ApiOperation({ summary: 'Get all loan cases for processing' })
    async getAllLoanCases() {
        return this.loanApplicationService.getAllLoanCases();
    }

    @Get('member/:memberNo/cases')
    @ApiOperation({ summary: 'Get loan cases for a specific member' })
    async getMemberLoanCases(@Param('memberNo') memberNo: string) {
        return this.loanApplicationService.getMemberLoanCases(memberNo);
    }

    @Get('member/:memberNo/pending')
    @ApiOperation({ summary: 'Get pending loans for a specific member' })
    async getMemberPendingLoans(@Param('memberNo') memberNo: string) {
        return this.loanApplicationService.getMemberPendingLoans(memberNo);
    }

    @Post('loan-application')
    @ApiOperation({ summary: 'Save a new loan application' })
    async saveLoanApplication(@Body() loanData: any) {
        return this.loanApplicationService.saveLoanApplication(loanData);
    }

    @Get('generate/loan-case-number')
    @ApiOperation({ summary: 'Generate next sequential loan case number' })
    async generateLoanCaseNumber() {
        const loanCaseNo = await this.loanApplicationService.generateNextLoanCaseNo();
        return { loanCaseNo };
    }

    // ==================== Sanction Operations ====================

    @Get('sanctioned')
    @ApiOperation({ summary: 'Get all sanctioned loan cases ready for disbursement' })
    async getSanctionedLoanCases() {
        return this.loanSanctionService.getSanctionedLoanCases();
    }

    @Get('case/:caseNo')
    @ApiOperation({ summary: 'Get loan details by case number' })
    async getLoanDetailsByCaseNo(@Param('caseNo') caseNo: string) {
        return this.loanSanctionService.getLoanDetailsByCaseNo(caseNo);
    }

    @Patch('sanction/:caseNo')
    @ApiOperation({ summary: 'Update loan with sanction details' })
    async updateLoanSanction(
        @Param('caseNo') caseNo: string,
        @Body() sanctionData: any
    ) {
        return this.loanSanctionService.updateLoanSanction(caseNo, sanctionData);
    }

    // ==================== Surety Operations ⭐ ====================

    @Patch('surety/:caseNo')
    @ApiOperation({ summary: 'Change loan sureties (guarantors)' })
    @ApiResponse({ status: 200, description: 'Sureties updated successfully' })
    async changeLoanSurety(
        @Param('caseNo') caseNo: string,
        @Body() suretyData: { surety1: string; surety2?: string }
    ) {
        return this.loanSuretyService.changeLoanSurety(caseNo, suretyData);
    }

    // NOTE: validate/:memberNo MUST be declared BEFORE surety/:caseNo (which is a PATCH, not GET)
    // and also before any GET surety/:caseNo to avoid NestJS route shadowing.
    @Get('surety/validate/:memberNo')
    @ApiOperation({ summary: 'Validate if a member can be a surety' })
    async validateSurety(@Param('memberNo') memberNo: string) {
        return this.loanSuretyService.validateSurety(memberNo);
    }

    @Get('surety/:caseNo')
    @ApiOperation({ summary: 'Get current sureties for a loan case' })
    async getLoanSureties(@Param('caseNo') caseNo: string) {
        return this.loanSuretyService.getLoanSureties(caseNo);
    }

    @Get('member/:memberNo/surety-cases')
    @ApiOperation({ summary: 'Get all loan cases for a member (pending + active) for surety change form' })
    async getMemberSuretyCases(@Param('memberNo') memberNo: string) {
        return this.loanSuretyService.getLoanSuretyCases(memberNo);
    }

    // ==================== Query Operations ====================

    @Get('search/member-loans')
    @ApiOperation({ summary: 'Search loans across loan_master and loan_pending' })
    async searchLoans(
        @Query('memberNumber') memberNumber?: string,
        @Query('loanCaseNo') loanCaseNo?: string,
        @Query('loanType') loanType?: string,
        @Query('status') status?: 'active' | 'pending' | 'all',
    ) {
        return this.loanQueryService.searchMemberLoans({
            memberNumber,
            loanCaseNo,
            loanType,
            status
        });
    }

    @Get('master/:caseNo')
    @ApiOperation({ summary: 'Get loan from loan_master (active loans)' })
    async getLoanFromMaster(@Param('caseNo') caseNo: string) {
        return this.loanQueryService.getMemberLoanFromMaster(caseNo);
    }

    @Get('pending/:caseNo')
    @ApiOperation({ summary: 'Get loan from loan_pending (pending loans)' })
    async getLoanFromPending(@Param('caseNo') caseNo: string) {
        return this.loanQueryService.getMemberLoanFromPending(caseNo);
    }

    @Get('member/:memberNo/master')
    @ApiOperation({ summary: 'Get all active loans for a member from loan_master' })
    async getMemberLoansFromMaster(@Param('memberNo') memberNo: string) {
        return this.loanQueryService.getMemberLoansFromMaster(memberNo);
    }

    @Get('member/:memberNo/all')
    @ApiOperation({ summary: 'Get all loans for a member from loan_pending' })
    async getMemberLoansFromPending(@Param('memberNo') memberNo: string) {
        return this.loanQueryService.getMemberLoansFromPending(memberNo);
    }

    @Get('master/:caseNo/emi-schedule')
    @ApiOperation({ summary: 'Get EMI schedule for loan from loan_master with payment status' })
    async getEmiScheduleFromMaster(@Param('caseNo') caseNo: string) {
        return this.loanQueryService.getEmiScheduleFromMaster(caseNo);
    }

    @Post('calculate-emi')
    @ApiOperation({ summary: 'Calculate EMI for given parameters' })
    async calculateEMI(
        @Body() body: { principal: number; annualRate: number; tenureMonths: number }
    ) {
        return this.loanQueryService.calculateEMI(
            body.principal,
            body.annualRate,
            body.tenureMonths
        );
    }

    @Post('amortization-schedule')
    @ApiOperation({ summary: 'Generate amortization schedule' })
    async generateAmortizationSchedule(
        @Body() body: { principal: number; annualRate: number; tenureMonths: number; startDate?: string }
    ) {
        return this.loanQueryService.generateAmortizationSchedule(
            body.principal,
            body.annualRate,
            body.tenureMonths,
            parseSafeDate(body.startDate)
        );
    }

    // ==================== Repayment / Early Closure Operations ====================
    // LoanRepaymentService (tiered grace/penal, RB-based early closure) previously had
    // no route reaching it at all -- these expose it through the real API surface,
    // matching this controller's existing style.

    @Post('repayment')
    @ApiOperation({ summary: 'Record a repayment against a loan, oldest-unpaid installment first' })
    async recordLoanRepayment(
        @Body() body: { mbno: string; loancaseno: string; paymentAmount: number; receiptNo?: string; narration?: string; username?: string; asOfDate?: string }
    ) {
        // asOfDate lets non-production testing simulate a future payment date
        // for penal/tier verification. Refused in production so a real client
        // can never backdate/forward-date an actual money-moving write.
        if (body.asOfDate && process.env.NODE_ENV === 'production') {
            throw new BadRequestException('asOfDate is not permitted in production');
        }
        return this.loanRepaymentService.recordLoanRepayment({
            ...body,
            asOfDate: process.env.NODE_ENV === 'production' ? undefined : parseSafeDate(body.asOfDate),
        });
    }

    @Get('due-status/:caseNo')
    @ApiOperation({ summary: 'What a loan currently owes, oldest-unpaid-first, including tiered penal' })
    async getDueStatus(
        @Param('caseNo') caseNo: string,
        @Query('asOfDate') asOfDate?: string,
    ) {
        return this.loanRepaymentService.getDueStatus(caseNo, parseSafeDate(asOfDate));
    }

    @Get('member/:mbno/repayment-history')
    @ApiOperation({ summary: 'Full repayment ledger history for a member, across all their loans' })
    async getMemberRepaymentHistory(@Param('mbno') mbno: string) {
        return this.loanRepaymentService.getMemberRepaymentHistory(mbno);
    }

    @Get('case/:caseNo/repayment-summary')
    @ApiOperation({ summary: 'Repayment totals (paid/principal/interest/penal) for one loan case' })
    async getLoanRepaymentSummary(@Param('caseNo') caseNo: string) {
        return this.loanRepaymentService.getLoanRepaymentSummary(caseNo);
    }

    @Post('early-closure/quote/:caseNo')
    @ApiOperation({ summary: 'Read-only early-closure quote using the true reducing-balance schedule' })
    async calculateEarlyClosure(
        @Param('caseNo') caseNo: string,
        @Body() body: { closureDate?: string; adjustment?: number; applyRdShare?: boolean },
    ) {
        return this.loanRepaymentService.calculateEarlyClosure(
            caseNo,
            parseSafeDate(body?.closureDate),
            body?.adjustment ?? 0,
            body?.applyRdShare ?? true,
        );
    }

    @Post('early-closure/execute/:caseNo')
    @ApiOperation({ summary: 'Actually settle a loan early -- writes ledger entries and zeroes the balance' })
    async executeEarlyClosure(
        @Param('caseNo') caseNo: string,
        @Body() body: { closureDate?: string; adjustment?: number; postedBy?: string; receiptNo?: string; applyRdShare?: boolean },
    ) {
        return this.loanRepaymentService.executeEarlyClosure(
            caseNo,
            parseSafeDate(body?.closureDate),
            body?.adjustment ?? 0,
            body?.postedBy || 'system',
            body?.receiptNo,
            body?.applyRdShare ?? true,
        );
    }

    // ==================== Month-End Balance Snapshot ====================

    @Post('month-end/snapshot')
    @ApiOperation({ summary: 'Capture a month-end loan balance snapshot for every member with an active loan' })
    async captureMonthEndSnapshot(@Body() body: { month: number; year: number }) {
        if (!body?.month || !body?.year) {
            throw new BadRequestException('month and year are required.');
        }
        return this.loanMonthEndService.captureMonthEndSnapshot(Number(body.month), Number(body.year));
    }

    @Get('month-end/report')
    @ApiOperation({ summary: 'The captured month-end loan balance snapshot for a given month/year' })
    async getMonthEndReport(@Query('month') month: string, @Query('year') year: string) {
        if (!month || !year) {
            throw new BadRequestException('month and year query params are required.');
        }
        return this.loanMonthEndService.getMonthlyBalanceReport(Number(month), Number(year));
    }

    @Get('month-end/history/:mbno')
    @ApiOperation({ summary: "A member's full month-end loan balance history" })
    async getMemberMonthEndHistory(@Param('mbno') mbno: string) {
        return this.loanMonthEndService.getMemberBalanceHistory(mbno);
    }
}
