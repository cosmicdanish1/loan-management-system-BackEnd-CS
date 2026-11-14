import { BadRequestException, Controller, Get, NotFoundException, Post, Body, Query, Param, ParseIntPipe } from '@nestjs/common';
import { QueueManualDto, QueueTransactionAlertDto } from '../dto/notification.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { NotificationService } from '../services/notification.service';
import { NotificationChannel } from '../entities/notification-log.entity';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationController {
    constructor(private readonly notificationService: NotificationService) {}

    @ApiOperation({ summary: 'List recent notification log entries (default last 100)' })
    @Get('history')
    async getHistory(@Query('limit') limit?: string) {
        // ES-360: a limit that is not a number used to reach the SQL as NaN; it is now checked and clamped to 1..1000 (default 100)
        const n = limit === undefined || limit === '' ? 100 : Number(limit);
        if (!Number.isInteger(n)) throw new BadRequestException('limit must be a whole number');
        return this.notificationService.getHistory(Math.min(1000, Math.max(1, n)));
    }

    @ApiOperation({ summary: 'Notification counts/stats (sent, failed, pending)' })
    @Get('stats')
    async getStats() {
        return this.notificationService.getStats();
    }

    @ApiOperation({ summary: 'Configured/available notification channels and their status (SMS/email/etc.)' })
    @Get('channel-status')
    async getChannelStatus() {
        return this.notificationService.getChannelStatus();
    }

    @ApiOperation({ summary: 'Queue a manual notification to a member for later sending' })
    @Post('queue-manual')
    async queueManual(@Body() data: QueueManualDto) {
        return this.notificationService.sendManualNotification(data);
    }

    @ApiOperation({ summary: 'Queue a manual notification to a member (use send-one/send-batch to deliver it)' })
    @Post('send-manual')
    async sendManual(@Body() data: QueueManualDto) {
        return this.notificationService.sendManualNotification(data);
    }

    @ApiOperation({ summary: 'Send a single queued notification by its log id' })
    @Post('send-one/:id')
    async sendOne(@Param('id', ParseIntPipe) id: number, @Body() data?: { channel?: NotificationChannel }) {
        if (id < 1) throw new BadRequestException('id must be a positive whole number');
        if (data?.channel !== undefined && !Object.values(NotificationChannel).includes(data.channel)) {
            throw new BadRequestException('Channel must be SMS, WHATSAPP or EMAIL.');
        }
        const result: any = await this.notificationService.sendNotification(id, data?.channel);
        // ES-360: an id that does not exist is a 404, not a 201 "created" with success:false inside
        if (result?.error === 'Not found') throw new NotFoundException('Notification ' + id + ' not found');
        return result;
    }

    @ApiOperation({ summary: 'Send a batch of queued notifications by their ids' })
    // 4.4 fix: a missing/malformed body crashed with 500 "ids is not iterable" /
    // "parameterValue.value is not iterable" — confirmed live with {} body.
    @Post('send-batch')
    async sendBatch(@Body() data: { ids: number[]; channel?: NotificationChannel }) {
        const ids = NotificationController.cleanIds(data?.ids);
        if (data?.channel !== undefined && !Object.values(NotificationChannel).includes(data.channel)) {
            throw new BadRequestException('Channel must be SMS, WHATSAPP or EMAIL.');
        }
        return this.notificationService.sendBatch(ids, data.channel);
    }

    @ApiOperation({ summary: 'Cancel a batch of queued notifications by their ids' })
    @Post('cancel-batch')
    async cancelBatch(@Body() data: { ids: number[] }) {
        return this.notificationService.cancelNotifications(NotificationController.cleanIds(data?.ids));
    }

    @ApiOperation({ summary: 'Manually run the EMI-due check and queue EMI reminder alerts' })
    @Post('trigger-emi-check')
    async triggerEmiCheck() {
        await this.notificationService.scheduleEmiAlerts();
        return { success: true, message: 'EMI alerts queued for review' };
    }

    @ApiOperation({ summary: 'Manually run the deposit-maturity check and queue maturity alerts' })
    @Post('trigger-maturity-check')
    async triggerMaturityCheck() {
        await this.notificationService.scheduleDepositMaturityAlerts();
        return { success: true, message: 'Maturity alerts queued for review' };
    }

    @ApiOperation({ summary: 'Queue a transaction alert notification for a member' })
    // 4.4 fix: a missing amount crashed with 500 "Cannot read properties of
    // undefined (reading 'toLocaleString')" inside the service — confirmed live
    // with {} body.
    @Post('queue-transaction-alert')
    async queueTransactionAlert(@Body() data: QueueTransactionAlertDto) {
        const queued = await this.notificationService.queueTransactionAlert(data);
        // no number on file for the member: nothing was queued (say so instead of answering with an empty 201)
        return queued ?? { queued: false, message: 'No phone number on file for member ' + data.memberNo + ': no alert was queued.' };
    }

    /** ES-360: ids must be whole numbers above 0, at most 500 per call, repeated ids counted once. */
    private static cleanIds(ids: unknown): number[] {
        if (!Array.isArray(ids) || ids.length === 0) throw new BadRequestException('ids must be a non-empty array of notification ids');
        if (ids.length > 500) throw new BadRequestException('At most 500 notification ids can be sent in one call');
        if (!ids.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)) throw new BadRequestException('Every id must be a whole number above 0');
        return [...new Set(ids as number[])];
    }
}
