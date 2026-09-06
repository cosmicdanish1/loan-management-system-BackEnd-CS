import { BadRequestException, Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ShortRecoveryService } from './services-v2/short-recovery.service';

@ApiTags('Transaction - Short Recovery')
@Controller('transactions/short-recovery')
export class ShortRecoveryController {
    constructor(private readonly shortRecoveryService: ShortRecoveryService) { }

    @Get()
    @ApiOperation({ summary: 'Get all short recoveries' })
    findAll(@Query('month') month: string, @Query('year') year: string, @Query('wing') wing: string) {
        return this.shortRecoveryService.findAll(month, year, wing);
    }

    // 4.4 fix: a missing demandId crashed with 500 "null value in column ..."
    // (unvalidated undefined reaching the DB) — confirmed live.
    @Post('adjust')
    @ApiOperation({ summary: 'Adjust a short recovery' })
    adjust(@Body() body: { demandId: number, reason: string, amount: number }) {
        if (!body?.demandId || !body?.reason || typeof body?.amount !== 'number') {
            throw new BadRequestException('demandId, reason, and a numeric amount are required');
        }
        return this.shortRecoveryService.adjust(body.demandId, body.reason, body.amount);
    }
}
