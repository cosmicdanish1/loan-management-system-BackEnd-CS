import { Controller, Get, Post, Body, Patch, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MemberFundsService } from '../services/member-funds.service';
import { UpdateMemberFundsDto } from '../dto/member-funds.dto';

@ApiTags('Admin - Member Funds (Migration)')
@Controller('admin/member-funds')
export class MemberFundsController {
    constructor(private readonly memberFundsService: MemberFundsService) { }

    @Get(':memberNo')
    @ApiOperation({ summary: 'Get member detailed balances for migration' })
    @ApiResponse({ status: 200, description: 'Return member fund balances.' })
    findOne(@Param('memberNo') memberNo: string) {
        return this.memberFundsService.findByMember(+memberNo);
    }

    @Patch(':memberNo')
    @ApiOperation({ summary: 'Update member detailed balances' })
    @ApiResponse({ status: 200, description: 'Balances updated successfully.' })
    update(@Param('memberNo') memberNo: string, @Body() updateDto: UpdateMemberFundsDto) {
        return this.memberFundsService.updateBalances(+memberNo, updateDto);
    }
}
