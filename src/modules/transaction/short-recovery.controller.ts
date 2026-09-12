import { Controller, Get, Post, Body, Query } from '@nestjs/common';
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

    @Post('adjust')
    @ApiOperation({ summary: 'Adjust a short recovery' })
    adjust(@Body() body: { demandId: number, reason: string, amount: number }) {
        return this.shortRecoveryService.adjust(body.demandId, body.reason, body.amount);
    }
}
