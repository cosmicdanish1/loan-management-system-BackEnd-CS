import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MemberBalanceService } from '../services/member-balance.service';
import { UpdateMemberBalanceDto } from '../dto/member-balance.dto';

@ApiTags('Admin - Member Balances')
@Controller('admin/member-balances')
export class MemberBalanceController {
    constructor(private readonly memberBalanceService: MemberBalanceService) { }

    @Get(':memberNo')
    @ApiOperation({ summary: 'Get member balance by Member No' })
    @ApiResponse({ status: 200, description: 'Return the member balance.' })
    @ApiResponse({ status: 404, description: 'Member balance not found.' })
    findOne(@Param('memberNo') memberNo: string) {
        return this.memberBalanceService.findOne(+memberNo);
    }

    @Patch(':memberNo')
    @ApiOperation({ summary: 'Update member balance' })
    @ApiResponse({ status: 200, description: 'Member balance updated successfully.' })
    @ApiResponse({ status: 404, description: 'Member balance not found.' })
    update(@Param('memberNo') memberNo: string, @Body() updateDto: UpdateMemberBalanceDto) {
        return this.memberBalanceService.update(+memberNo, updateDto);
    }
}
