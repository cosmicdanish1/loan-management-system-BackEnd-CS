import { Controller, Get, Post, Body, Patch, Param, ParseIntPipe, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MemberFundsService } from '../services/member-funds.service';
import { UpdateMemberFundsDto } from '../dto/member-funds.dto';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@ApiTags('Admin - Member Funds (Migration)')
@Controller('admin/member-funds')
export class MemberFundsController {
    private readonly logger = new Logger(MemberFundsController.name);

    constructor(private readonly memberFundsService: MemberFundsService) { }

    @Get('list')
    @ApiOperation({ summary: 'Get ordered list of member numbers in fundsmaster (optionally filtered by wing)' })
    async getMemberList(@Query('wing') wing?: string) {
        this.logger.log(`[MemberFunds] GET member list for navigation${wing ? ` (wing=${wing})` : ''}`);
        const list = await this.memberFundsService.getMemberList(wing);
        return list;
    }

    @Get('wings')
    @ApiOperation({ summary: 'Get wings that have members in fundsmaster' })
    async getWings() {
        this.logger.log('[MemberFunds] GET wings list');
        return this.memberFundsService.getWings();
    }

    @Get(':memberNo')
    @ApiOperation({ summary: 'Get member detailed balances' })
    @ApiResponse({ status: 200, description: 'Return member fund balances.' })
    async findOne(@Param('memberNo', ParseIntPipe) memberNo: number) {
        this.logger.log(`[MemberFunds] GET balances for member: ${memberNo}`);
        const data = await this.memberFundsService.findByMember(memberNo);
        this.logger.log(`[MemberFunds] Returning data for member ${memberNo}`);
        return data;
    }

    @Patch(':memberNo')
    @ApiOperation({ summary: 'Update member detailed balances' })
    @ApiResponse({ status: 200, description: 'Balances updated successfully.' })
    async update(
        @Param('memberNo', ParseIntPipe) memberNo: number,
        @Body() updateDto: UpdateMemberFundsDto,
        @CurrentUser() user: any,
    ) {
        const changedBy = user?.username || 'system';
        this.logger.log(`[MemberFunds] PATCH balances for member: ${memberNo} by ${changedBy}`);
        const result = await this.memberFundsService.updateBalances(memberNo, updateDto, changedBy);
        this.logger.log(`[MemberFunds] Saved balances for member ${memberNo}`);
        return result;
    }
}
