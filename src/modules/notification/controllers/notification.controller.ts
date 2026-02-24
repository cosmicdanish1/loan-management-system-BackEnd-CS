import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { NotificationService } from '../services/notification.service';
import { NotificationChannel } from '../entities/notification-log.entity';

@Controller('notifications')
export class NotificationController {
    constructor(private readonly notificationService: NotificationService) { }

    @Get('history')
    async getHistory(@Query('limit') limit?: string) {
        return this.notificationService.getHistory(limit ? parseInt(limit) : 50);
    }

    @Get('stats')
    async getStats() {
        const pendingCount = await this.notificationService.getPendingCount();
        return { pendingCount };
    }

    @Post('send-manual')
    async sendManual(@Body() data: {
        memberNo: string;
        channel: NotificationChannel;
        message: string;
        recipient: string;
    }) {
        return this.notificationService.sendManualNotification(data);
    }

    @Post('trigger-emi-check')
    async triggerEmiCheck() {
        // Manual trigger for testing
        await this.notificationService.scheduleEmiAlerts();
        return { success: true, message: 'EMI alert generation triggered' };
    }
}
