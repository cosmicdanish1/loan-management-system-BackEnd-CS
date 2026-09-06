import {
    BadRequestException,
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VoucherService, PassTransactionService } from './services-v2';
import { MemberBalanceTransferService } from './services-v2/member-balance-transfer.service';

/**
 * Transaction V2 Controller - Restructured endpoints using separated services.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * All routes are prefixed with /v2/transactions to run alongside original routes.
 * After migration is complete, these will replace the original routes.
 */
@ApiTags('Transactions')
@Controller('transactions')
export class TransactionV2Controller {
    private readonly logger = new Logger(TransactionV2Controller.name);

    constructor(
        private readonly voucherService: VoucherService,
        private readonly passTransactionService: PassTransactionService,
        private readonly memberBalanceTransferService: MemberBalanceTransferService,
    ) { }

    // ==================== Voucher Operations ====================

    @Post('voucher')
    @ApiOperation({ summary: 'Create a generic voucher (Payment/Receipt/Journal)' })
    @ApiResponse({ status: 201, description: 'Voucher created successfully' })
    async createVoucher(@Body() voucherData: any) {
        return this.voucherService.createVoucher(voucherData);
    }

    @Post('loan-voucher')
    @ApiOperation({ summary: 'Generate a loan disbursement voucher' })
    @ApiResponse({ status: 201, description: 'Loan voucher generated successfully' })
    async generateLoanVoucher(@Body() voucherData: any) {
        return this.voucherService.generateLoanVoucher(voucherData);
    }

    @Get('vouchers/pending')
    @ApiOperation({ summary: 'Get all pending vouchers' })
    async getPendingVouchers() {
        return this.voucherService.getPendingVouchers();
    }

    @Get('voucher/:voucherNo')
    @ApiOperation({ summary: 'Get voucher details by number' })
    async getVoucherDetails(@Param('voucherNo') voucherNo: string) {
        return this.voucherService.getVoucherDetails(voucherNo);
    }

    @Delete('voucher/:voucherNo')
    @ApiOperation({ summary: 'Delete/Reject a pending voucher' })
    @ApiResponse({ status: 200, description: 'Voucher deleted successfully' })
    async deleteVoucher(@Param('voucherNo') voucherNo: string) {
        return this.voucherService.deleteVoucher(voucherNo);
    }

    // ==================== Pass Transaction Operations ====================

    @Post('pass/:voucherNo')
    @ApiOperation({ summary: 'Pass transaction - final posting to ledger and cashbook' })
    @ApiResponse({ status: 200, description: 'Transaction passed successfully' })
    async passTransaction(
        @Param('voucherNo') voucherNo: string,
        @Body() body?: { postedBy?: string }
    ) {
        return this.passTransactionService.passTransaction(voucherNo, body?.postedBy || 'admin');
    }

    @Post('reverse/:voucherNo')
    @ApiOperation({ summary: 'Reverse a posted transaction (ADMIN ONLY — destructive)' })
    @ApiResponse({ status: 200, description: 'Transaction reversed successfully' })
    async reverseTransaction(
        @Param('voucherNo') voucherNo: string,
        @Body() body?: { reversedBy?: string; confirmReverse?: boolean }
    ) {
        // 5.1 fix: was reaching callers as 500 instead of 400.
        if (!body?.confirmReverse) {
            throw new BadRequestException('Reversal requires confirmReverse: true. This is a destructive operation that deletes ledger entries.');
        }
        this.logger.warn(`Transaction reversal requested for ${voucherNo} by ${body?.reversedBy || 'unknown'}`);
        return this.passTransactionService.reverseTransaction(voucherNo, body?.reversedBy || 'admin');
    }

    @Post('fix-trans-types')
    @ApiOperation({ summary: 'One-time fix: convert P/R to DR/CR in transactions table' })
    async fixTransTypes() {
        const dr = await this.voucherService['dataSource'].query(
            `UPDATE transactions SET trans_type = 'DR' WHERE trans_type = 'P'`
        );
        const cr = await this.voucherService['dataSource'].query(
            `UPDATE transactions SET trans_type = 'CR' WHERE trans_type = 'R'`
        );
        return {
            success: true,
            message: 'Transaction types fixed',
            drUpdated: dr[1] || 0,
            crUpdated: cr[1] || 0,
        };
    }

    @Post('member-balance-transfer/generate')
    @ApiOperation({ summary: 'Generate member balance transfer preview' })
    async generateMemberBalanceTransfer(@Body() body: any) {
        return this.memberBalanceTransferService.generate(
            body.debitHead, body.creditHead, body.creditLimit || 0,
            body.excessHead, body.balanceAsOn,
        );
    }

    // 4.4 fix: a missing entries array crashed with 500 "Cannot read properties
    // of undefined" inside the service — confirmed live.
    @Post('member-balance-transfer/post')
    @ApiOperation({ summary: 'Post member balance transfer to ledger' })
    async postMemberBalanceTransfer(@Body() body: any) {
        if (!Array.isArray(body?.entries) || body.entries.length === 0 || !body?.debitHead || !body?.creditHead) {
            throw new BadRequestException('entries (non-empty array), debitHead, and creditHead are required');
        }
        return this.memberBalanceTransferService.post(
            body.entries, body.debitHead, body.creditHead,
            body.excessHead, body.postedBy || 'admin',
            body.creditLimit || 999999999, body.balanceAsOn,
        );
    }

    @Get('pending-loans')
    @ApiOperation({ summary: 'Get all pending loan applications for approval' })
    async getPendingLoans() {
        const loans = await this.voucherService['dataSource'].query(`
            SELECT lp.loancaseno, lp.mbno::text, lp.loantype, lp.applied_amt::text,
                   lp.app_date, lp.flg_sanctioned, lp.flg_paid, COALESCE(lp.pass_flag, 'N') as pass_flag,
                   TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) as member_name
            FROM loan_pending lp
            LEFT JOIN member_master m ON lp.mbno = m.mbno
            WHERE lp.flg_sanctioned = 'N' OR (lp.flg_sanctioned = 'Y' AND lp.flg_paid = 'N')
            ORDER BY lp.app_date DESC
        `);
        return { loans, pendingCount: loans.filter((l: any) => (l.pass_flag || 'N') === 'N').length };
    }

    @Post('loan-pass-flag')
    @ApiOperation({ summary: 'Update loan pass flag (Y=Approve, N=Pending, D=Decline)' })
    async updateLoanPassFlag(@Body() body: { loanCaseNo: string; passFlag: string }) {
        if (!['Y', 'N', 'D'].includes(body.passFlag)) {
            // 5.1 fix: was reaching callers as 500 instead of 400.
            throw new BadRequestException('Invalid pass flag. Use Y, N, or D.');
        }
        await this.voucherService['dataSource'].query(
            `UPDATE loan_pending SET pass_flag = $1 WHERE loancaseno::text = $2`,
            [body.passFlag, body.loanCaseNo]
        );
        return { success: true, message: `Loan ${body.loanCaseNo} flag set to ${body.passFlag}` };
    }
}
