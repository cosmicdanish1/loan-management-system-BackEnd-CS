import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VoucherService, PassTransactionService } from './services-v2';
import { RequireAuthCode } from '../auth/twofa/require-auth-code';
import { RequirePassAuthority } from '../auth/guards/pass-authority.guard';
import { RequireMenuAction } from '../auth/guards/menu-right.guard';

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
    constructor(
        private readonly voucherService: VoucherService,
        private readonly passTransactionService: PassTransactionService,
    ) { }

    // ==================== Voucher Operations ====================

    @RequireMenuAction('RECEIPT_PAYMENT_VOUCHER_CREATION', 'RECEIPT_PAYMENT', 'VOUCHER_PAYMENT', 'JOURNAL_TRANSFER_ENTRY', 'LOAN_PAYMENT') // ES-464
    @Post('voucher')
    @ApiOperation({ summary: 'Create a generic voucher (Payment/Receipt/Journal)' })
    @ApiResponse({ status: 201, description: 'Voucher created successfully' })
    async createVoucher(@Body() voucherData: any, @Req() req: any) {
        // the voucher is recorded under the signed-in user, never a name sent in the body (ES-413)
        return this.voucherService.createVoucher({ ...voucherData, createdBy: req?.user?.username || 'SYSTEM' });
    }

    @RequireMenuAction('LOAN_PAYMENT', 'LOAN_ENTRY', 'LOAN_REPAYMENT') // ES-464
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

    @RequireMenuAction('RECEIPT_PAYMENT_VOUCHER_CREATION', 'RECEIPT_PAYMENT', 'VOUCHER_PAYMENT', 'JOURNAL_TRANSFER_ENTRY', 'LOAN_PAYMENT', 'PASS_TRANSACTIONS') // ES-464
    @Delete('voucher/:voucherNo')
    @RequirePassAuthority() // rejecting a pending voucher is part of the pass decision (ES-362)
    @ApiOperation({ summary: 'Delete/Reject a pending voucher' })
    @ApiResponse({ status: 200, description: 'Voucher deleted successfully' })
    async deleteVoucher(@Param('voucherNo') voucherNo: string) {
        return this.voucherService.deleteVoucher(voucherNo);
    }

    // ==================== Pass Transaction Operations ====================

    // ES-116: each switch (all vouchers / re-agreement only) is independent; one code covers both.
    @RequireMenuAction('PASS_TRANSACTIONS')
    @Post('pass/:voucherNo')
    @RequirePassAuthority() // ES-362
    @RequireAuthCode('pass_transactions', async (req, tf) => (await tf.isReagreementVoucher(req.params.voucherNo)) ? 'reagreement_pass' : null)
    @ApiOperation({ summary: 'Pass transaction - final posting to ledger and cashbook' })
    @ApiResponse({ status: 200, description: 'Transaction passed successfully' })
    async passTransaction(
        @Param('voucherNo') voucherNo: string,
        @Req() req: any,
    ) {
        // ES-464: the posting user is the signed-in user (token), never a name sent in the body
        return this.passTransactionService.passTransaction(voucherNo, req?.user?.username || 'system');
    }

    @RequireMenuAction('PASS_TRANSACTIONS')
    @Post('reverse/:voucherNo')
    @RequirePassAuthority() // ES-362
    @RequireAuthCode('reverse_transactions')
    @ApiOperation({ summary: 'Reverse a posted transaction' })
    @ApiResponse({ status: 200, description: 'Transaction reversed successfully' })
    async reverseTransaction(
        @Param('voucherNo') voucherNo: string,
        @Req() req: any,
    ) {
        return this.passTransactionService.reverseTransaction(voucherNo, req?.user?.username || 'system');
    }
}
