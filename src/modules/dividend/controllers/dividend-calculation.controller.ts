import { Controller, Get, Post, Body, Query, ParseIntPipe, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DividendCalculationService } from '../services/dividend-calculation.service';

@ApiTags('Dividend - Calculation')
@Controller('dividend/calculation')
export class DividendCalculationController {
    constructor(private readonly service: DividendCalculationService) {}

    @Get('preview')
    @ApiOperation({ summary: 'Read-only preview of the Total Product dividend calculation for a financial year — writes nothing' })
    async preview(
        @Query('yearcode', ParseIntPipe) yearcode: number,
        @Query('dividendRate') dividendRate: string,
    ) {
        if (!dividendRate) throw new BadRequestException('dividendRate query param is required.');
        return this.service.previewDividendForYear(yearcode, Number(dividendRate));
    }

    @Post('commit')
    @ApiOperation({ summary: 'Commits the dividend calculation for a financial year into dividend_master — does NOT credit Share Value' })
    async commit(@Body() body: { yearcode: number; dividendRate: number }) {
        if (!body?.yearcode || !body?.dividendRate) {
            throw new BadRequestException('yearcode and dividendRate are required.');
        }
        return this.service.commitDividendForYear(Number(body.yearcode), Number(body.dividendRate));
    }
}
