import { ParseIntPipe, Controller, Get, Post, Body, Patch, Param, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MemberFundsService } from '../services/member-funds.service';
import { UpdateMemberFundsDto } from '../dto/member-funds.dto';

@ApiTags('Admin - Member Funds (Migration)')
@Controller('admin/member-funds')
export class MemberFundsController {
    private readonly logger = new Logger(MemberFundsController.name);

    constructor(private readonly memberFundsService: MemberFundsService) { }

    @Get('list')
    @ApiOperation({ summary: 'Get ordered list of all member numbers in fundsmaster for navigation' })
    async getMemberList(@Query('wing') wing?: string) {
        this.logger.log('[MemberFunds] GET member list for navigation');
        const list = await this.memberFundsService.getMemberList(wing);
        return list;
    }

    // ES-491: must be declared before ':memberNo', otherwise "wings" is parsed as a member number (400).
    @Get('wings')
    @ApiOperation({ summary: 'Get wings that have members in fundsmaster' })
    async getWings() {
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
    async update(@Param('memberNo', ParseIntPipe) memberNo: number, @Body() updateDto: UpdateMemberFundsDto) {
        this.logger.log(`[MemberFunds] PATCH balances for member: ${memberNo}, payload: ${JSON.stringify(updateDto)}`);
        const result = await this.memberFundsService.updateBalances(memberNo, updateDto);
        this.logger.log(`[MemberFunds] Saved balances for member ${memberNo}`);
        return result;
    }
}
