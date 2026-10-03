import { Controller, Get, Param, Query } from '@nestjs/common';
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

    @Get('list/by-date')
    async getAllVoucherReferences() {
        return this.printVoucherService.getAllVoucherReferences();
    }

    @Get('journal/list/all')
    async getAllJournalVoucherNos(): Promise<string[]> {
        return this.printVoucherService.getAllJournalVoucherNos();
    }

    @Get('journal/list/by-date')
    async getAllJournalVoucherReferences() {
        return this.printVoucherService.getAllJournalVoucherReferences();
    }

    @Get('journal/:voucherNo')
    async getJournalVoucher(@Param('voucherNo') voucherNo: string, @Query('date') date?: string): Promise<JournalVoucherDto> {
        return this.printVoucherService.getJournalVoucherByNo(voucherNo, date);
    }

    @Get(':voucherNo')
    async getVoucher(@Param('voucherNo') voucherNo: string, @Query('date') date?: string): Promise<VoucherPrintDto> {
        return this.printVoucherService.getVoucherByNo(voucherNo, date);
    }
}
