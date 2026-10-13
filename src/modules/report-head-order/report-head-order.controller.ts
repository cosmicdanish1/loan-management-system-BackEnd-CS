import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { ReportHeadOrderService } from './report-head-order.service';

@ApiTags('Report Head Order')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard)
@Controller('report-head-order')
export class ReportHeadOrderController {
  constructor(private readonly service: ReportHeadOrderService) {}

  @Get()
  @ApiOperation({ summary: 'All heads in current report order' })
  async getOrder() {
    return { success: true, data: await this.service.getOrder() };
  }

  @Put()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Save the report head order (first code = top)' })
  async saveOrder(@Body() body: { codes: string[] }) {
    return { success: true, data: await this.service.saveOrder(body?.codes) };
  }

  @Post('reset')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reset the report head order to head-code order' })
  async reset() {
    return { success: true, data: await this.service.resetOrder() };
  }
}
