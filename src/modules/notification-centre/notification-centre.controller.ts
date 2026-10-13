import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { NotificationCentreService } from './notification-centre.service';

const userOf = (req: any): string => String(req.user?.username || 'system');

// Every logged-in user sees the same notifications; read / unread is kept per user.
@ApiTags('Notification Centre')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard)
@Controller('notification-centre')
export class NotificationCentreController {
  constructor(private readonly service: NotificationCentreService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Unread / open counts for the current user' })
  async summary(@Req() req: any) {
    return { success: true, data: await this.service.summary(userOf(req)) };
  }

  @Get('list')
  @ApiOperation({ summary: 'Notifications with filters (status, kind, severity, unreadOnly, search) and paging' })
  async list(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('severity') severity?: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return {
      success: true,
      data: await this.service.list(userOf(req), {
        status, kind, severity, unreadOnly: unreadOnly === 'true', search, limit: Number(limit) || 50, offset: Number(offset) || 0,
      }),
    };
  }

  @Post('sync')
  @ApiOperation({ summary: 'Re-check the data now and refresh the notifications' })
  async sync() {
    return { success: true, data: await this.service.sync() };
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark every open notification (optionally one kind) as read' })
  async readAll(@Req() req: any, @Body() body: { kind?: string }) {
    return { success: true, data: await this.service.markAllRead(userOf(req), body?.kind) };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read' })
  async read(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return { success: true, data: await this.service.markRead(id, userOf(req)) };
  }

  @Post(':id/unread')
  @ApiOperation({ summary: 'Mark one notification as unread' })
  async unread(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return { success: true, data: await this.service.markUnread(id, userOf(req)) };
  }
}
