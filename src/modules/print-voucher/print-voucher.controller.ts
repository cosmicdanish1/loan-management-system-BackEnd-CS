import { Controller, Get, Param } from '@nestjs/common';
import { PrintVoucherService } from './print-voucher.service';
import { VoucherPrintDto } from './dto/print-voucher.dto';

import { JournalVoucherDto } from './dto/journal-voucher.dto';

@Controller('print-voucher')
export class PrintVoucherController {
    constructor(private readonly printVoucherService: PrintVoucherService) { }

    @Get('list/all')
    async getAllVoucherNos(): Promise<string[]> {
        return this.printVoucherService.getAllVoucherNos();
    }

    @Get('journal/list/all')
    async getAllJournalVoucherNos(): Promise<string[]> {
        return this.printVoucherService.getAllJournalVoucherNos();
    }

    @Get('journal/:voucherNo')
    async getJournalVoucher(@Param('voucherNo') voucherNo: string): Promise<JournalVoucherDto> {
        return this.printVoucherService.getJournalVoucherByNo(voucherNo);
    }

    @Get(':voucherNo')
    async getVoucher(@Param('voucherNo') voucherNo: string): Promise<VoucherPrintDto> {
        return this.printVoucherService.getVoucherByNo(voucherNo);
    }
}
