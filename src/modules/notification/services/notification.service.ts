import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan, Between } from 'typeorm';
import {
    NotificationLog,
    NotificationChannel,
    NotificationStatus,
    NotificationType,
} from '../entities/notification-log.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Member } from '../../member/entities/member.entity';

@Injectable()
export class NotificationService {
    private readonly logger = new Logger(NotificationService.name);

    constructor(
        @InjectRepository(NotificationLog)
        private readonly notificationRepository: Repository<NotificationLog>,
        @InjectRepository(Member)
        private readonly memberRepository: Repository<Member>,
        private readonly dataSource: DataSource,
    ) { }

    /**
     * Send a manual notification
     */
    async sendManualNotification(data: {
        memberNo: string;
        channel: NotificationChannel;
        message: string;
        recipient: string;
    }) {
        const log = this.notificationRepository.create({
            ...data,
            type: NotificationType.MANUAL,
            status: NotificationStatus.PENDING,
        });

        const savedLog = await this.notificationRepository.save(log);

        // Simulate sending
        return this.processNotification(savedLog.id);
    }

    /**
     * Internal processor to "send" the notification (Mock)
     */
    async processNotification(id: number) {
        const log = await this.notificationRepository.findOne({ where: { id } });
        if (!log) return;

        try {
            this.logger.log(`[MOCK SEND] Channel: ${log.channel}, To: ${log.recipient}, Message: ${log.message}`);

            // Simulate network delay
            await new Promise(resolve => setTimeout(resolve, 1000));

            log.status = NotificationStatus.SENT;
            log.sentAt = new Date();
            await this.notificationRepository.save(log);

            return { success: true, logId: log.id };
        } catch (error) {
            log.status = NotificationStatus.FAILED;
            log.errorMessage = error.message;
            await this.notificationRepository.save(log);
            return { success: false, error: error.message };
        }
    }

    /**
     * Automated: Start of Day EMI Missing Alerts (Runs at 8 AM)
     */
    @Cron(CronExpression.EVERY_DAY_AT_8AM)
    async scheduleEmiAlerts() {
        this.logger.log('Running automated EMI deficit checks...');

        // Query members with demand balance > 0
        const membersWithDeficit = await this.dataSource.query(`
      SELECT m.mbno, m.phone_off as phone, dm.balance_for_month as amount
      FROM member_master m
      JOIN demand_master dm ON m.mbno = dm.mbno
      WHERE dm.balance_for_month > 0
      AND dm.demand_for_month = EXTRACT(MONTH FROM CURRENT_DATE)
      AND dm.demand_for_year = EXTRACT(YEAR FROM CURRENT_DATE)
    `);

        for (const member of membersWithDeficit) {
            const message = `Reminder: Your EMI for this month has a deficit of ₹${member.amount}. Please clear it to avoid penalties. - Espat Society`;

            // Queue SMS
            await this.queueNotification({
                memberNo: member.mbno,
                channel: NotificationChannel.SMS,
                type: NotificationType.EMI_ALERT,
                message,
                recipient: member.phone || '0000000000',
            });

            // Queue WhatsApp
            await this.queueNotification({
                memberNo: member.mbno,
                channel: NotificationChannel.WHATSAPP,
                type: NotificationType.EMI_ALERT,
                message,
                recipient: member.phone || '0000000000',
            });
        }
    }

    /**
     * Automated: End of Month Email Summary (Runs last day of month at 10 PM)
     */
    @Cron('0 22 28-31 * *')
    async scheduleMonthlySummaries() {
        // Check if it's actually the last day
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);

        if (tomorrow.getMonth() === today.getMonth()) return; // Not the last day

        this.logger.log('Generating monthly Email summaries...');

        const activeMembers = await this.memberRepository.find({ where: { status: 'ACTIVE' } });

        for (const member of activeMembers) {
            // Mock summary
            const message = `Hello ${member.firstName}, your monthly statement for ${today.toLocaleString('default', { month: 'long' })} is ready. Total Savings: ₹XXXX. Active Loans: X.`;

            await this.queueNotification({
                memberNo: member.memberNumber,
                channel: NotificationChannel.EMAIL,
                type: NotificationType.MONTHLY_SUMMARY,
                message,
                recipient: member.email || 'member@example.com',
            });
        }
    }

    /**
     * Helper to queue a notification
     */
    private async queueNotification(data: Partial<NotificationLog>) {
        const log = this.notificationRepository.create({
            ...data,
            status: NotificationStatus.PENDING,
        });
        const saved = await this.notificationRepository.save(log);
        // In a production app, we would use a real queue like BullMQ here.
        // For now, we'll process it after a short delay to simulate async.
        setTimeout(() => this.processNotification(saved.id), 5000);
    }

    /**
     * Get notification history for the center
     */
    async getHistory(limit: number = 50) {
        return this.notificationRepository.find({
            order: { createdAt: 'DESC' },
            take: limit,
            relations: ['member'],
        });
    }

    async getPendingCount() {
        return this.notificationRepository.count({ where: { status: NotificationStatus.PENDING } });
    }
}
