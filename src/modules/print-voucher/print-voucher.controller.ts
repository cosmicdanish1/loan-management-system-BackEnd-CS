import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrintVoucherService } from './print-voucher.service';
import { VoucherPrintDto } from './dto/print-voucher.dto';

import { JournalVoucherDto } from './dto/journal-voucher.dto';

@ApiTags('Print Voucher')
@Controller('print-voucher')
export class PrintVoucherController {
    constructor(private readonly printVoucherService: PrintVoucherService) { }

    @ApiOperation({ summary: 'List all voucher numbers (for the print-voucher picker)' })
    @Get('list/all')
    async getAllVoucherNos(): Promise<string[]> {
        return this.printVoucherService.getAllVoucherNos();
    }

    @ApiOperation({ summary: 'List all journal voucher numbers' })
    @Get('journal/list/all')
    async getAllJournalVoucherNos(): Promise<string[]> {
        return this.printVoucherService.getAllJournalVoucherNos();
    }

    @ApiOperation({ summary: 'Get a journal voucher by number (printable payload)' })
    @Get('journal/:voucherNo')
    async getJournalVoucher(@Param('voucherNo') voucherNo: string): Promise<JournalVoucherDto> {
        return this.printVoucherService.getJournalVoucherByNo(voucherNo);
    }

    @ApiOperation({ summary: 'Get a voucher by number (printable payload)' })
    @Get(':voucherNo')
    async getVoucher(@Param('voucherNo') voucherNo: string): Promise<VoucherPrintDto> {
        return this.printVoucherService.getVoucherByNo(voucherNo);
    }
}
