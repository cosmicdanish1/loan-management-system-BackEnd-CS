import { Controller, Get, Post, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ShareMonthEndService } from '../services/share-month-end.service';

@ApiTags('Dividend - Share Monthly Balance')
@Controller('dividend/share-snapshot')
export class ShareMonthEndController {
    constructor(private readonly service: ShareMonthEndService) {}

    @Post()
    @ApiOperation({ summary: 'Capture a month-end Share Capital balance snapshot for every member holding shares' })
    async captureSnapshot(@Body() body: { month: number; year: number }) {
        if (!body?.month || !body?.year) {
            throw new BadRequestException('month and year are required.');
        }
        return this.service.captureMonthEndSnapshot(Number(body.month), Number(body.year));
    }

    @Get('report')
    @ApiOperation({ summary: 'The captured Share Capital balance snapshot for a given month/year' })
    async getReport(@Query('month') month: string, @Query('year') year: string) {
        if (!month || !year) {
            throw new BadRequestException('month and year query params are required.');
        }
        return this.service.getMonthlyBalanceReport(Number(month), Number(year));
    }

    @Get('history/:mbno')
    @ApiOperation({ summary: "A member's full Share Capital monthly balance history" })
    async getHistory(@Param('mbno') mbno: string) {
        return this.service.getMemberBalanceHistory(mbno);
    }
}
