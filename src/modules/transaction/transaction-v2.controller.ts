import {
    Controller,
    Get,
    Post,
    Body,
    Param,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VoucherService, PassTransactionService } from './services-v2';

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

    @Post('voucher')
    @ApiOperation({ summary: 'Generate a loan disbursement voucher' })
    @ApiResponse({ status: 201, description: 'Voucher generated successfully' })
    async generateVoucher(@Body() voucherData: any) {
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
    @ApiOperation({ summary: 'Reverse a posted transaction' })
    @ApiResponse({ status: 200, description: 'Transaction reversed successfully' })
    async reverseTransaction(
        @Param('voucherNo') voucherNo: string,
        @Body() body?: { reversedBy?: string }
    ) {
        return this.passTransactionService.reverseTransaction(voucherNo, body?.reversedBy || 'admin');
    }
}
