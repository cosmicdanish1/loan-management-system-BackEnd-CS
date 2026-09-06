import { BadRequestException, Controller, Get, Post, Body, Query, Param, ParseIntPipe } from '@nestjs/common';
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
        return this.notificationService.getHistory(limit ? parseInt(limit) : 100);
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
    async queueManual(@Body() data: {
        memberNo: string;
        channel: NotificationChannel;
        message: string;
        recipient: string;
    }) {
        return this.notificationService.sendManualNotification(data);
    }

    @ApiOperation({ summary: 'Send a manual notification to a member immediately' })
    @Post('send-manual')
    async sendManual(@Body() data: {
        memberNo: string;
        channel: NotificationChannel;
        message: string;
        recipient: string;
    }) {
        return this.notificationService.sendManualNotification(data);
    }

    @ApiOperation({ summary: 'Send a single queued notification by its log id' })
    @Post('send-one/:id')
    async sendOne(@Param('id', ParseIntPipe) id: number, @Body() data?: { channel?: NotificationChannel }) {
        return this.notificationService.sendNotification(id, data?.channel);
    }

    @ApiOperation({ summary: 'Send a batch of queued notifications by their ids' })
    // 4.4 fix: a missing/malformed body crashed with 500 "ids is not iterable" /
    // "parameterValue.value is not iterable" — confirmed live with {} body.
    @Post('send-batch')
    async sendBatch(@Body() data: { ids: number[]; channel?: NotificationChannel }) {
        if (!Array.isArray(data?.ids) || data.ids.length === 0) {
            throw new BadRequestException('ids must be a non-empty array of notification ids');
        }
        return this.notificationService.sendBatch(data.ids, data.channel);
    }

    @ApiOperation({ summary: 'Cancel a batch of queued notifications by their ids' })
    @Post('cancel-batch')
    async cancelBatch(@Body() data: { ids: number[] }) {
        if (!Array.isArray(data?.ids) || data.ids.length === 0) {
            throw new BadRequestException('ids must be a non-empty array of notification ids');
        }
        return this.notificationService.cancelNotifications(data.ids);
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
    async queueTransactionAlert(@Body() data: {
        memberNo: string;
        transactionType: string;
        amount: number;
        recipient?: string;
        channel?: NotificationChannel;
    }) {
        if (!data?.memberNo || !data?.transactionType || typeof data?.amount !== 'number') {
            throw new BadRequestException('memberNo, transactionType, and a numeric amount are required');
        }
        return this.notificationService.queueTransactionAlert(data);
    }
}
