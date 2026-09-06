import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
    NotificationLog,
    NotificationChannel,
    NotificationStatus,
    NotificationType,
} from '../entities/notification-log.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Member } from '../../member/entities/member.entity';
import * as nodemailer from 'nodemailer';

@Injectable()
export class NotificationService {
    private readonly logger = new Logger(NotificationService.name);
    private emailTransporter: nodemailer.Transporter | null = null;

    constructor(
        @InjectRepository(NotificationLog)
        private readonly notificationRepository: Repository<NotificationLog>,
        @InjectRepository(Member)
        private readonly memberRepository: Repository<Member>,
        private readonly dataSource: DataSource,
        private readonly configService: ConfigService,
    ) {
        this.initEmailTransporter();
    }

    private initEmailTransporter() {
        const host = this.configService.get('SMTP_HOST');
        const user = this.configService.get('SMTP_USER');
        const pass = this.configService.get('SMTP_PASS');
        if (host && user && pass) {
            this.emailTransporter = nodemailer.createTransport({
                host, port: parseInt(this.configService.get('SMTP_PORT') || '587'),
                secure: false, auth: { user, pass },
            });
            this.logger.log('Email transporter initialized');
        } else {
            this.logger.warn('SMTP not configured — email disabled');
        }
    }

    // ── Dedup & Ref helpers ──────────────────────────────────
    private generateDedupeKey(memberNo: string, channel: string, type: string, dateKey: string): string {
        const raw = `${memberNo}|${channel}|${type}|${dateKey}`;
        return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 64);
    }

    private generateMsgRef(): string {
        const ts = Date.now().toString(36).toUpperCase();
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        return `MSG-${ts}-${rand}`;
    }

    // ── Sending methods ──────────────────────────────────────

    private async sendEmail(to: string, subject: string, message: string): Promise<void> {
        if (!this.emailTransporter) throw new Error('SMTP not configured');
        await this.emailTransporter.sendMail({
            from: this.configService.get('SMTP_FROM') || this.configService.get('SMTP_USER'),
            to, subject,
            html: this.buildEmailTemplate(subject, message),
        });
    }

    private async sendSMS(phone: string, message: string): Promise<void> {
        const authKey = this.configService.get('MSG91_AUTH_KEY');
        if (!authKey) throw new Error('MSG91 not configured');
        const res = await fetch('https://control.msg91.com/api/v5/flow/', {
            method: 'POST',
            headers: { authkey: authKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sender: this.configService.get('MSG91_SENDER_ID') || 'FIBECS',
                route: this.configService.get('MSG91_ROUTE') || '4',
                country: '91',
                sms: [{ message, to: [phone.replace(/^\+91/, '')] }],
            }),
        });
        if (!res.ok) throw new Error(`MSG91 ${res.status}: ${await res.text()}`);
    }

    private async sendWhatsApp(phone: string, message: string): Promise<void> {
        const apiKey = this.configService.get('WHATSAPP_API_KEY');
        if (!apiKey) throw new Error('WhatsApp not configured');
        const res = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
            method: 'POST',
            headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                channel: 'whatsapp',
                source: this.configService.get('WHATSAPP_SOURCE') || '',
                destination: phone.startsWith('91') ? phone : `91${phone}`,
                message: JSON.stringify({ type: 'text', text: message }),
                'src.name': this.configService.get('WHATSAPP_APP_NAME') || 'FIBE',
            }),
        });
        if (!res.ok) throw new Error(`Gupshup ${res.status}: ${await res.text()}`);
    }

    private buildEmailTemplate(subject: string, body: string): string {
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f4f4f7">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff">
  <tr><td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px 32px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:20px">FIBE Credit Society</h1>
    <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px">Espat Karmchari Co-Operative Credit Society Ltd.</p>
  </td></tr>
  <tr><td style="padding:32px">
    <h2 style="color:#1e293b;font-size:16px;margin:0 0 16px">${subject}</h2>
    <div style="color:#475569;font-size:14px;line-height:1.6">${body.replace(/\n/g, '<br>')}</div>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center">
    <p style="color:#94a3b8;font-size:11px;margin:0">Automated message from FIBE — Paper White Technology</p>
  </td></tr>
</table></body></html>`;
    }

    // ── Send one notification ────────────────────────────────

    async sendNotification(id: number, overrideChannel?: NotificationChannel) {
        const log = await this.notificationRepository.findOne({ where: { id } });
        if (!log) return { success: false, error: 'Not found' };
        if (log.status === NotificationStatus.SENT) return { success: true, logId: id };

        if (overrideChannel && overrideChannel !== log.channel) {
            log.channel = overrideChannel;
        }

        try {
            switch (log.channel) {
                case NotificationChannel.EMAIL:
                    await this.sendEmail(log.recipient, 'FIBE Notification', log.message); break;
                case NotificationChannel.SMS:
                    await this.sendSMS(log.recipient, log.message); break;
                case NotificationChannel.WHATSAPP:
                    await this.sendWhatsApp(log.recipient, log.message); break;
            }
            log.status = NotificationStatus.SENT;
            log.sentAt = new Date();
            await this.notificationRepository.save(log);
            this.logger.log(`[${log.msgRef}] Sent via ${log.channel} to ${log.recipient}`);
            return { success: true, logId: id, msgRef: log.msgRef };
        } catch (error) {
            log.status = NotificationStatus.FAILED;
            log.errorMessage = error.message;
            await this.notificationRepository.save(log);
            this.logger.error(`[${log.msgRef}] FAILED: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // ── Batch operations ─────────────────────────────────────

    async sendBatch(ids: number[], overrideChannel?: NotificationChannel) {
        let sent = 0, failed = 0;
        for (const id of ids) {
            const r = await this.sendNotification(id, overrideChannel);
            if (r.success) sent++; else failed++;
        }
        return { sent, failed, total: ids.length };
    }

    async cancelNotifications(ids: number[]) {
        await this.notificationRepository.update(
            { id: In(ids), status: NotificationStatus.PENDING },
            { status: NotificationStatus.CANCELLED },
        );
        return { cancelled: ids.length };
    }

    // ── Queue with dedup ─────────────────────────────────────

    async queueNotification(data: Partial<NotificationLog> & { dedupeKey?: string }) {
        if (data.dedupeKey) {
            const existing = await this.notificationRepository.findOne({
                where: { dedupeKey: data.dedupeKey },
            });
            if (existing) {
                this.logger.debug(`Dedup skip: ${data.dedupeKey}`);
                return existing;
            }
        }

        const log = this.notificationRepository.create({
            ...data,
            msgRef: this.generateMsgRef(),
            status: NotificationStatus.PENDING,
        });

        try {
            return await this.notificationRepository.save(log);
        } catch (e) {
            if (e.code === '23505') {
                this.logger.debug(`Dedup constraint skip: ${data.dedupeKey}`);
                return null;
            }
            throw e;
        }
    }

    // ── Manual queue ─────────────────────────────────────────

    async sendManualNotification(data: {
        memberNo: string; channel: NotificationChannel;
        message: string; recipient: string;
    }) {
        return this.queueNotification({ ...data, type: NotificationType.MANUAL });
    }

    // ── Transaction alert queue ──────────────────────────────

    async queueTransactionAlert(data: {
        memberNo: string; transactionType: string;
        amount: number; recipient?: string; channel?: NotificationChannel;
    }) {
        const memberInfo = await this.dataSource.query(`
            SELECT TRIM(COALESCE(f_name,'') || ' ' || COALESCE(l_name,'')) as name, phoneno as phone
            FROM member_master WHERE CAST(mbno AS text) = $1 LIMIT 1
        `, [data.memberNo]);
        const name = memberInfo[0]?.name || 'Member';
        const phone = data.recipient || memberInfo[0]?.phone || '';
        const message = `Dear ${name}, your ${data.transactionType} of Rs.${data.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} has been processed. — FIBE Credit Society`;
        const today = new Date().toISOString().slice(0, 10);

        return this.queueNotification({
            memberNo: data.memberNo,
            channel: data.channel || NotificationChannel.SMS,
            type: NotificationType.TRANSACTION,
            message, recipient: phone,
            dedupeKey: this.generateDedupeKey(data.memberNo, data.channel || 'SMS', `TXN-${data.transactionType}-${data.amount}`, today),
        });
    }

    // ── Cron: EMI alerts (queue only) ────────────────────────

    @Cron(CronExpression.EVERY_DAY_AT_8AM)
    async scheduleEmiAlerts() {
        this.logger.log('Generating EMI deficit alerts...');
        try {
            const members = await this.dataSource.query(`
                SELECT CAST(m.mbno AS text) as mbno,
                    TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.l_name,'')) as name,
                    m.phoneno as phone, CAST(dm.balance_for_month AS numeric) as amount
                FROM member_master m
                JOIN demand_master dm ON m.mbno = dm.mbno
                WHERE dm.balance_for_month > 0
                AND dm.demand_for_month = EXTRACT(MONTH FROM CURRENT_DATE)
                AND dm.demand_for_year = EXTRACT(YEAR FROM CURRENT_DATE)
            `);
            const today = new Date().toISOString().slice(0, 10);
            let queued = 0;
            for (const m of members) {
                if (!m.phone) continue;
                const result = await this.queueNotification({
                    memberNo: m.mbno, channel: NotificationChannel.SMS,
                    type: NotificationType.EMI_ALERT,
                    message: `Dear ${m.name}, your EMI has a deficit of Rs.${parseFloat(m.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}. Please clear it. — FIBE`,
                    recipient: m.phone,
                    dedupeKey: this.generateDedupeKey(m.mbno, 'SMS', 'EMI_ALERT', today),
                });
                if (result) queued++;
            }
            this.logger.log(`EMI alerts: ${queued} queued, ${members.length - queued} skipped (dedup)`);
            return { queued, total: members.length };
        } catch (e) { this.logger.error(`EMI cron: ${e.message}`); return { queued: 0, error: e.message }; }
    }

    // ── Cron: Deposit maturity alerts (queue only) ───────────

    @Cron('0 9 * * *')
    async scheduleDepositMaturityAlerts() {
        this.logger.log('Generating deposit maturity alerts...');
        try {
            const deposits = await this.dataSource.query(`
                SELECT CAST(fd."memberId" AS text) as mbno, fd."accountNumber" as acc_no,
                    'FD' as type, fd."maturityDate" as mat_date,
                    TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.l_name,'')) as name, m.phoneno as phone
                FROM fixed_deposits fd
                LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(fd."memberId" AS text)
                WHERE fd."maturityDate" BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND fd.status = 'ACTIVE'
                UNION ALL
                SELECT CAST(rd."memberId" AS text), rd."accountNumber", 'RD',
                    rd."maturityDate", TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.l_name,'')), m.phoneno
                FROM recurring_deposits rd
                LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(rd."memberId" AS text)
                WHERE rd."maturityDate" BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND rd.status = 'ACTIVE'
            `);
            const today = new Date().toISOString().slice(0, 10);
            let queued = 0;
            for (const d of deposits) {
                if (!d.phone) continue;
                const dt = new Date(d.mat_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
                const result = await this.queueNotification({
                    memberNo: d.mbno, channel: NotificationChannel.SMS,
                    type: NotificationType.MATURITY_ALERT,
                    message: `Dear ${d.name}, your ${d.type} A/c ${d.acc_no} matures on ${dt}. Please visit the office. — FIBE`,
                    recipient: d.phone,
                    dedupeKey: this.generateDedupeKey(d.mbno, 'SMS', `MATURITY-${d.acc_no}`, today),
                });
                if (result) queued++;
            }
            this.logger.log(`Maturity alerts: ${queued} queued`);
            return { queued, total: deposits.length };
        } catch (e) { this.logger.error(`Maturity cron: ${e.message}`); return { queued: 0, error: e.message }; }
    }

    // ── Cron: Monthly summaries (queue only) ─────────────────

    @Cron('0 22 28-31 * *')
    async scheduleMonthlySummaries() {
        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        if (tomorrow.getMonth() === today.getMonth()) return;
        this.logger.log('Generating monthly summaries...');
        try {
            const members = await this.dataSource.query(`
                SELECT CAST(m.mbno AS text) as mbno,
                    TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.l_name,'')) as name, m.phoneno as phone
                FROM member_master m WHERE m.isactive = 'Y' LIMIT 200
            `);
            const monthKey = `${today.getFullYear()}-${today.getMonth() + 1}`;
            const monthName = today.toLocaleString('default', { month: 'long', year: 'numeric' });
            for (const m of members) {
                if (!m.phone) continue;
                await this.queueNotification({
                    memberNo: m.mbno, channel: NotificationChannel.SMS,
                    type: NotificationType.MONTHLY_SUMMARY,
                    message: `Dear ${m.name}, your monthly statement for ${monthName} is ready. Visit the office. — FIBE`,
                    recipient: m.phone,
                    dedupeKey: this.generateDedupeKey(m.mbno, 'SMS', 'MONTHLY', monthKey),
                });
            }
        } catch (e) { this.logger.error(`Monthly cron: ${e.message}`); }
    }

    // ── Queries ──────────────────────────────────────────────

    async getHistory(limit = 200) {
        try {
            const rows = await this.dataSource.query(`
                SELECT id, mbno::text as "memberNo", channel, type, message, recipient, status,
                       "errorMessage", "sentAt", metadata, "createdAt", "updatedAt"
                FROM notification_logs
                ORDER BY "createdAt" DESC
                LIMIT $1
            `, [limit]);
            return rows;
        } catch (e) {
            this.logger.error('getHistory failed:', e);
            return [];
        }
    }

    async getStats() {
        try {
            const [pending, sent, failed] = await Promise.all([
                this.notificationRepository.count({ where: { status: NotificationStatus.PENDING } }),
                this.notificationRepository.count({ where: { status: NotificationStatus.SENT } }),
                this.notificationRepository.count({ where: { status: NotificationStatus.FAILED } }),
            ]);
            return { totalPending: pending, totalSent: sent, totalFailed: failed };
        } catch { return { totalPending: 0, totalSent: 0, totalFailed: 0 }; }
    }

    getChannelStatus() {
        return {
            email: !!this.emailTransporter,
            sms: !!this.configService.get('MSG91_AUTH_KEY'),
            whatsapp: !!this.configService.get('WHATSAPP_API_KEY'),
        };
    }
}
