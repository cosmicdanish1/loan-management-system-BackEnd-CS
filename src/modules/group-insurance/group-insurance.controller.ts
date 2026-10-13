import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { GroupInsuranceService } from './group-insurance.service';

@ApiTags('Group Insurance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard)
@Controller('group-insurance')
export class GroupInsuranceController {
  constructor(private readonly service: GroupInsuranceService) {}

  @Get('context')
  @ApiOperation({ summary: 'Financial years and the insurance run already posted for each' })
  async context() {
    return { success: true, data: await this.service.context() };
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'One posted run with the per-member charges' })
  async runDetail(
    @Param('id', ParseIntPipe) id: number,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return { success: true, data: await this.service.runDetail(id, { search, limit: Number(limit) || 100, offset: Number(offset) || 0 }) };
  }

  @Post('preview')
  @ApiOperation({ summary: 'Calculate the per-member charges for a lump sum without posting anything' })
  async preview(@Body() body: any) {
    return {
      success: true,
      data: await this.service.preview({
        yearcode: Number(body?.yearcode), lumpSum: Number(body?.lumpSum),
        postingDate: body?.postingDate || undefined, filter: body?.filter, search: body?.search,
        limit: Number(body?.limit) || 100, offset: Number(body?.offset) || 0,
      }),
    };
  }

  @Post('post')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Post the yearly group insurance: one Journal voucher, RD debited for every charged member' })
  async post(@Body() body: any, @Req() req: any) {
    const username = req.user?.username || 'system';
    return {
      success: true,
      data: await this.service.post(
        { yearcode: Number(body?.yearcode), lumpSum: Number(body?.lumpSum), postingDate: body?.postingDate || undefined },
        username,
      ),
    };
  }
}
