import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { JournalTransferService } from './services-v2/journal-transfer.service';
import { CreateJournalVoucherDto } from './dto/journal-transfer.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Journal Transfer Transactions')
@Controller('transactions/journal')
export class JournalTransferController {
    constructor(private readonly journalService: JournalTransferService) { }

    @Post('post')
    @ApiOperation({ summary: 'Post a multi-row balanced journal entry' })
    async postJournal(@Body() dto: CreateJournalVoucherDto, @Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.journalService.postJournalEntry(dto, username);
    }
}
