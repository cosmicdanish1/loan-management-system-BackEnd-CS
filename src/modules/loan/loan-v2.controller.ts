import {
    Controller,
    Get,
    Post,
    Patch,
    Body,
    Param,
    Query,
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
    LoanEligibilityService,
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
        private readonly loanEligibilityService: LoanEligibilityService,
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

    @Get('member/:memberNo/balances')
    @ApiOperation({ summary: 'Get member outstanding loan balances from member_balances' })
    async getMemberBalances(@Param('memberNo') memberNo: string) {
        return this.loanApplicationService.getMemberBalances(memberNo);
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

    @Get('eligibility/:memberNo')
    @ApiOperation({ summary: 'Check member eligibility for loan based on Share and FD values' })
    async checkEligibility(
        @Param('memberNo') memberNo: string,
        @Query('amount') amount: string
    ) {
        return this.loanEligibilityService.checkEligibility(memberNo, parseFloat(amount || '0'));
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

    // ==================== Repayment Operations ====================

    @Post('repayment')
    @ApiOperation({ summary: 'Record a loan repayment installment' })
    async recordLoanRepayment(@Body() dto: {
        mbno: string;
        loancaseno: string;
        paymentMonth: number;
        paymentYear: number;
        paymentAmount: number;
        receiptNo?: string;
        narration?: string;
        username?: string;
    }) {
        return this.loanRepaymentService.recordLoanRepayment(dto);
    }

    @Get('member/:memberNo/repayment-history')
    @ApiOperation({ summary: 'Get full repayment history for a member' })
    async getMemberRepaymentHistory(@Param('memberNo') memberNo: string) {
        return this.loanRepaymentService.getMemberRepaymentHistory(memberNo);
    }

    @Get('case/:caseNo/repayment-summary')
    @ApiOperation({ summary: 'Get repayment summary for a specific loan case' })
    async getLoanRepaymentSummary(@Param('caseNo') caseNo: string) {
        return this.loanRepaymentService.getLoanRepaymentSummary(caseNo);
    }

    @Get('case/:caseNo/due-status')
    @ApiOperation({ summary: 'Get the oldest-unpaid-first due breakdown for a loan (principal/interest/penal)' })
    async getDueStatus(@Param('caseNo') caseNo: string) {
        return this.loanRepaymentService.getDueStatus(caseNo);
    }

    @Get('case/:caseNo/early-closure')
    @ApiOperation({ summary: 'Calculate the final amount to close a loan early' })
    async calculateEarlyClosure(
        @Param('caseNo') caseNo: string,
        @Query('closureDate') closureDate?: string,
        @Query('adjustment') adjustment?: string,
    ) {
        return this.loanRepaymentService.calculateEarlyClosure(
            caseNo,
            parseSafeDate(closureDate),
            adjustment ? parseFloat(adjustment) : 0,
        );
    }

    @Post('case/:caseNo/early-closure')
    @ApiOperation({ summary: 'Execute an early closure — settles every remaining installment and zeroes the balance' })
    async executeEarlyClosure(
        @Param('caseNo') caseNo: string,
        @Body() body: { closureDate?: string; adjustment?: number; receiptNo?: string; username?: string },
    ) {
        return this.loanRepaymentService.executeEarlyClosure(
            caseNo,
            parseSafeDate(body.closureDate),
            body.adjustment || 0,
            body.username || 'system',
            body.receiptNo,
        );
    }

    // ==================== Month-End Operations ====================

    @Post('month-end/snapshot')
    @ApiOperation({ summary: 'Capture month-end loan balance snapshot for all members' })
    async captureMonthEndSnapshot(@Body() body: { month: number; year: number }) {
        return this.loanMonthEndService.captureMonthEndSnapshot(body.month, body.year);
    }

    @Get('month-end/report')
    @ApiOperation({ summary: 'Get month-end loan balance report' })
    async getMonthlyBalanceReport(
        @Query('month') month: string,
        @Query('year') year: string,
    ) {
        return this.loanMonthEndService.getMonthlyBalanceReport(parseInt(month), parseInt(year));
    }

    @Get('member/:memberNo/balance-history')
    @ApiOperation({ summary: 'Get month-end balance history for a member' })
    async getMemberBalanceHistory(@Param('memberNo') memberNo: string) {
        return this.loanMonthEndService.getMemberBalanceHistory(memberNo);
    }
}
