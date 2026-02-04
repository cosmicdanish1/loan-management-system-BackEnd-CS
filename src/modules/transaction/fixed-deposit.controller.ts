import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { FixedDepositService } from './services-v2/fixed-deposit.service';

@ApiTags('Transactions')
@Controller('transactions/fixed-deposit')
export class FixedDepositController {
    constructor(private readonly fixedDepositService: FixedDepositService) { }

    @Post()
    @ApiOperation({ summary: 'Create a new Fixed Deposit' })
    async createFixedDeposit(@Body() data: any) {
        return this.fixedDepositService.createFixedDeposit(data);
    }

    @Get('member/:memberNo')
    @ApiOperation({ summary: 'Get active FDs for a member' })
    async getActiveFDs(@Param('memberNo') memberNo: string) {
        return this.fixedDepositService.getActiveFDsByMember(memberNo);
    }

    @Post('interest-voucher')
    @ApiOperation({ summary: 'Create Interest Voucher' })
    async createInterestVoucher(@Body() data: any) {
        return this.fixedDepositService.createInterestVoucher(data);
    }

    @Post('close')
    @ApiOperation({ summary: 'Close/Withdraw Fixed Deposit' })
    async closeFixedDeposit(@Body() data: any) {
        return this.fixedDepositService.closeFixedDeposit(data);
    }
}
