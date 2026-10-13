import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { SupportQuery } from '../entities/support-query.entity';
import { CreateSupportQueryDto } from '../dto/create-support-query.dto';
import { JiraClientService } from './jira-client.service';
import { TelegramClientService } from '../../alerts/telegram-client.service';
import { AlertSettingsService, JIRA_CREATE } from '../../alerts/alert-settings.service';
import { AlertService, esc } from '../../alerts/alert.service';

const TYPE_LABEL: Record<string, string> = {
    BUG: 'Bug',
    QUESTION: 'Question',
    DATA_CORRECTION: 'Data correction',
    FEATURE_REQUEST: 'Feature request',
    OTHER: 'Other',
};

const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

export interface Reporter {
    userId: string | null;
    username: string | null;
    role: string | null;
    isAdmin: boolean;
}

@Injectable()
export class SupportQueryService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SupportQueryService.name);
    private readonly inFlight = new Set<number>();
    /** Queries already announced on Discord (Telegram has its own retry/status columns). */
    private readonly discordNotified = new Set<number>();
    private timer?: NodeJS.Timeout;

    constructor(
        @InjectRepository(SupportQuery) private readonly repo: Repository<SupportQuery>,
        private readonly jira: JiraClientService,
        private readonly telegram: TelegramClientService,
        private readonly alertSettings: AlertSettingsService,
        private readonly alerts: AlertService,
    ) { }

    onModuleInit() {
        // Re-deliver anything that was saved while Jira/Telegram were down or not configured yet.
        this.timer = setInterval(() => this.retryPending().catch((e) => this.logger.error(e.message)), RETRY_INTERVAL_MS);
        this.timer.unref();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    /** Saves the query, then delivers in the background so the user is never kept waiting on Jira. */
    async create(dto: CreateSupportQueryDto, reporter: Reporter, screenshotPath?: string): Promise<SupportQuery> {
        const saved = await this.repo.save(
            this.repo.create({
                subject: dto.subject.trim(),
                description: dto.description.trim(),
                module: dto.module?.trim() || null,
                queryType: dto.queryType || 'OTHER',
                priority: dto.priority || 'MEDIUM',
                reporterUserId: reporter.userId,
                reporterUsername: reporter.username,
                reporterRole: reporter.role,
                route: dto.route || null,
                appVersion: dto.appVersion || null,
                clientInfo: dto.clientInfo || null,
                screenshotPath: screenshotPath || null,
            }),
        );
        void this.deliver(saved.id);
        return saved;
    }

    listMine(username: string) {
        return this.repo.find({ where: { reporterUsername: username }, order: { createdAt: 'DESC' }, take: 100 });
    }

    listAll(status?: string) {
        return this.repo.find({ where: status ? { status: status as any } : {}, order: { createdAt: 'DESC' }, take: 500 });
    }

    async getOne(id: number, reporter: Reporter): Promise<SupportQuery> {
        const q = await this.repo.findOne({ where: { id } });
        if (!q) throw new NotFoundException(`Query #${id} not found`);
        if (!reporter.isAdmin && q.reporterUsername !== reporter.username) {
            throw new ForbiddenException('You can only view your own queries');
        }
        return q;
    }

    /** Admin: reset the attempt counters and deliver again right now. */
    async retry(id: number): Promise<SupportQuery> {
        const q = await this.repo.findOne({ where: { id } });
        if (!q) throw new NotFoundException(`Query #${id} not found`);
        if (q.jiraStatus !== 'SENT') await this.repo.update(id, { jiraStatus: 'PENDING', jiraAttempts: 0 });
        if (q.telegramStatus !== 'SENT') await this.repo.update(id, { telegramStatus: 'PENDING', telegramAttempts: 0 });
        await this.deliver(id);
        return this.repo.findOneOrFail({ where: { id } });
    }

    async retryPending(): Promise<void> {
        const rows = await this.repo.find({
            where: [
                { jiraStatus: In(['PENDING', 'FAILED', 'DISABLED']), jiraAttempts: LessThan(MAX_ATTEMPTS) },
                { telegramStatus: In(['PENDING', 'FAILED', 'DISABLED']), telegramAttempts: LessThan(MAX_ATTEMPTS) },
            ],
            order: { id: 'ASC' },
            take: 20,
        });
        for (const row of rows) await this.deliver(row.id);
    }

    /** Jira first (so the Telegram message can carry the key), each channel independent of the other. */
    private async deliver(id: number): Promise<void> {
        if (this.inFlight.has(id)) return;
        this.inFlight.add(id);
        try {
            const q = await this.repo.findOne({ where: { id } });
            if (!q) return;

            if (q.jiraStatus !== 'SENT' && q.jiraAttempts < MAX_ATTEMPTS) {
                if (!this.alertSettings.flag(JIRA_CREATE)) {
                    // Switched off in Settings: skip for good (not retried), so switching it on never replays old queries.
                    await this.repo.update(id, { jiraStatus: 'SKIPPED', jiraError: 'Ticket creation is switched off in Settings' });
                } else if (!this.jira.isConfigured()) {
                    await this.repo.update(id, { jiraStatus: 'DISABLED', jiraError: 'Jira is not configured (.env)' });
                } else {
                    try {
                        // Create the issue once; keep the key if a later step (attachment) fails.
                        if (!q.jiraKey) {
                            q.jiraKey = await this.jira.createIssue({
                                summary: `[Query #${q.id}] [${TYPE_LABEL[q.queryType] || 'Other'}] ${q.subject}`,
                                description: this.jiraBody(q),
                                priority: q.priority,
                                labels: ['support-query', `type-${q.queryType.toLowerCase().replace(/_/g, '-')}`, ...(q.module ? [q.module.replace(/\s+/g, '-')] : [])],
                            });
                            await this.repo.update(id, { jiraKey: q.jiraKey });
                        }
                        if (q.screenshotPath) await this.jira.attachFile(q.jiraKey, q.screenshotPath).catch((e) =>
                            this.logger.warn(`Screenshot attach failed for #${id}: ${e.message}`));
                        await this.repo.update(id, { jiraStatus: 'SENT', jiraError: null });
                    } catch (e: any) {
                        await this.repo.update(id, { jiraStatus: 'FAILED', jiraAttempts: q.jiraAttempts + 1, jiraError: String(e.message).slice(0, 1000) });
                        this.logger.warn(`Jira delivery failed for query #${id}: ${e.message}`);
                    }
                }
            }

            const fresh = await this.repo.findOne({ where: { id } });

            // Discord: one best-effort card per new query (routing/mute/test handled by AlertService).
            // Only for queries raised in the last 10 minutes, so retries after a restart never replay old ones.
            if (fresh && !this.discordNotified.has(id) && Date.now() - new Date(fresh.createdAt).getTime() < 10 * 60 * 1000) {
                this.discordNotified.add(id);
                this.alerts.send('query.new', 'queries', this.discordBody(fresh), 'discord');
            }
            if (fresh && fresh.telegramStatus !== 'SENT' && fresh.telegramAttempts < MAX_ATTEMPTS) {
                if (!this.alertSettings.isEnabled('query.new')) {
                    // Muted in Settings: skip for good (not retried), so turning it back on never replays old queries.
                    await this.repo.update(id, { telegramStatus: 'SKIPPED', telegramError: 'Muted in Settings → Telegram Alerts' });
                } else if (!this.telegram.isConfigured()) {
                    await this.repo.update(id, { telegramStatus: 'DISABLED', telegramError: 'Telegram is not configured (.env)' });
                } else {
                    try {
                        await this.telegram.send(this.telegramBody(fresh));
                        await this.repo.update(id, { telegramStatus: 'SENT', telegramError: null });
                    } catch (e: any) {
                        await this.repo.update(id, { telegramStatus: 'FAILED', telegramAttempts: fresh.telegramAttempts + 1, telegramError: String(e.message).slice(0, 1000) });
                        this.logger.warn(`Telegram delivery failed for query #${id}: ${e.message}`);
                    }
                }
            }
        } finally {
            this.inFlight.delete(id);
        }
    }

    private jiraBody(q: SupportQuery): string {
        return [
            q.description,
            '',
            '--- Context (captured automatically) ---',
            `Query #: ${q.id}`,
            `Raised by: ${q.reporterUsername || 'unknown'} (${q.reporterRole || 'no role'})`,
            `Type: ${TYPE_LABEL[q.queryType] || 'Other'}`,
            `Module: ${q.module || 'not specified'}`,
            `Screen: ${q.route || 'unknown'}`,
            `App version: ${q.appVersion || 'unknown'}`,
            `Client: ${q.clientInfo || 'unknown'}`,
            `Raised at: ${q.createdAt.toISOString()}`,
        ].join('\n');
    }

    /** The same new-query card the other alerts use (Telegram-style HTML, converted for Discord). */
    private discordBody(q: SupportQuery): string {
        const pri = ({ LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' } as Record<string, string>)[q.priority] || '🟡';
        const priName = q.priority.charAt(0) + q.priority.slice(1).toLowerCase();
        const desc = q.description.length > 400 ? `${q.description.slice(0, 400)}…` : q.description;
        return [
            `🆕 <b>New query SQ-${String(q.id).padStart(5, '0')}</b>`,
            `<b>${esc(q.subject)}</b>`,
            `${pri} ${priName}   ·   🏷 ${esc(TYPE_LABEL[q.queryType] || 'Other')}${q.module ? `   ·   📂 ${esc(q.module)}` : ''}`,
            `👤 ${esc(q.reporterUsername || 'unknown')}${q.appVersion ? `   🖥 v${esc(q.appVersion)}` : ''}`,
            '',
            `<i>${esc(desc)}</i>`,
            q.jiraKey ? `\n🔗 Jira: <code>${esc(q.jiraKey)}</code>` : '',
        ].join('\n');
    }

    private telegramBody(q: SupportQuery): string {
        const link = q.jiraKey && this.jira.isConfigured() ? `\nJira: ${this.jira.browseUrl(q.jiraKey)}` : '';
        return [
            `New ${TYPE_LABEL[q.queryType] || 'query'} #${q.id} [${q.priority}]${q.jiraKey ? ` — ${q.jiraKey}` : ''}`,
            q.subject,
            '',
            `From: ${q.reporterUsername || 'unknown'}${q.module ? ` · ${q.module}` : ''}`,
            q.description.length > 600 ? `${q.description.slice(0, 600)}…` : q.description,
            link,
        ].join('\n');
    }
}
