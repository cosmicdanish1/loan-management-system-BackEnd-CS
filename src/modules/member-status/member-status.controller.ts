import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { MemberStatusService, StatusCategory } from './member-status.service';

@ApiTags('Member Status')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard)
@Controller('member-status')
export class MemberStatusController {
  constructor(private readonly service: MemberStatusService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Counts: ready to mark inactive / retired with RD left / retiring soon' })
  async summary(@Query('months') months?: string) {
    return { success: true, data: await this.service.summary(Number(months) || 12) };
  }

  @Get('list')
  @ApiOperation({ summary: 'Members for one category (ready | retired-rd | upcoming)' })
  async list(
    @Query('category') category: StatusCategory,
    @Query('months') months?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return {
      success: true,
      data: await this.service.list({
        category, months: Number(months) || 12, search, limit: Number(limit) || 100, offset: Number(offset) || 0,
      }),
    };
  }

  @Get(':memberNo/check')
  @ApiOperation({ summary: 'Active/inactive status of one member and any warnings' })
  async check(@Param('memberNo') memberNo: string) {
    return { success: true, data: await this.service.check(memberNo) };
  }

  @Get(':memberNo/history')
  @ApiOperation({ summary: 'Mark-inactive / re-activate history of one member' })
  async history(@Param('memberNo') memberNo: string) {
    return { success: true, data: await this.service.history(memberNo) };
  }

  @Post(':memberNo/inactive')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Manually mark a member inactive (warnings need force=true)' })
  async markInactive(
    @Param('memberNo') memberNo: string,
    @Body() body: { reason: string; force?: boolean },
    @Req() req: any,
  ) {
    const by = req.user?.username || 'system';
    return { success: true, data: await this.service.markInactive(memberNo, body?.reason, body?.force === true, by) };
  }

  @Post(':memberNo/reactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Make an inactive member active again' })
  async reactivate(@Param('memberNo') memberNo: string, @Body() body: { reason: string }, @Req() req: any) {
    const by = req.user?.username || 'system';
    return { success: true, data: await this.service.reactivate(memberNo, body?.reason, by) };
  }
}
