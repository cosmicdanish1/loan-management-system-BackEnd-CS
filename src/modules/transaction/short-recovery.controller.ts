import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ShortRecoveryService } from './services-v2/short-recovery.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Transaction - Short Recovery')
@Controller('transactions/short-recovery')
@UseGuards(JwtAuthGuard)
export class ShortRecoveryController {
    constructor(private readonly shortRecoveryService: ShortRecoveryService) { }

    @Get()
    @ApiOperation({ summary: 'Get all short recoveries' })
    findAll(@Query('month') month: string, @Query('year') year: string, @Query('wing') wing: string) {
        return this.shortRecoveryService.findAll(month, year, wing);
    }

    @Post('adjust')
    @ApiOperation({ summary: 'Adjust a short recovery' })
    adjust(@Body() body: { demandId: string, reason: string, amount: number }) {
        return this.shortRecoveryService.adjust(body.demandId, body.reason, body.amount);
    }
}
