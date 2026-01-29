import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MemberAdminService } from '../services/member-admin.service';

@ApiTags('Admin - Member Management')
@Controller('admin/members')
export class MemberAdminController {
    constructor(private readonly service: MemberAdminService) { }

    @Get(':memberNo')
    @ApiOperation({ summary: 'Get member details by ID' })
    async getMember(@Param('memberNo') memberNo: number) {
        return this.service.findOne(memberNo);
    }

    @Post('transfer')
    @ApiOperation({ summary: 'Transfer member to a new office' })
    @ApiResponse({ status: 200, description: 'Member transferred successfully' })
    async transferMember(@Body() data: { memberNo: number; newOfficeId: string }) {
        return this.service.updateOffice(data.memberNo, data.newOfficeId);
    }
}
