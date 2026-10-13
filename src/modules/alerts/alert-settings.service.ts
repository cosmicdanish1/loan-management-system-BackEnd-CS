import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ALERT_CATALOG, ALERT_GROUPS, AlertGroup, EXTRA_KEYS, MASTER_KEY, findAlert } from './alert-catalog';

interface Row { enabled: boolean; param: number | null; telegram: boolean; discord: boolean }

export const DEST_TELEGRAM = 'dest.telegram';
export const DEST_DISCORD = 'dest.discord';
export const JIRA_CREATE = 'jira.create';

/**
 * What is switched on in Settings: which alerts are sent, to which destination (Telegram and/or
 * Discord), their thresholds, the master/destination switches and the "create Jira tickets" flag.
 * Stored in `alert_settings` (one row per key), cached in memory and refreshed every 30 s.
 * A missing row means "use the default" (everything on), and if the table cannot be read
 * everything falls back to on, so a settings problem can never silence the alerts silently.
 */
@Injectable()
export class AlertSettingsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AlertSettingsService.name);
    private rows = new Map<string, Row>();
    private timer?: NodeJS.Timeout;

    constructor(private readonly ds: DataSource) { }

    async onModuleInit() {
        try {
            await this.ds.query(`
                CREATE TABLE IF NOT EXISTS alert_settings (
                    key varchar(50) PRIMARY KEY,
                    enabled boolean NOT NULL DEFAULT true,
                    param numeric,
                    telegram boolean NOT NULL DEFAULT true,
                    discord boolean NOT NULL DEFAULT true,
                    updated_at timestamptz NOT NULL DEFAULT now(),
                    updated_by varchar(100)
                )`);
            // Tables created before Discord existed lack the destination columns.
            await this.ds.query('ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS telegram boolean NOT NULL DEFAULT true');
            await this.ds.query('ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS discord boolean NOT NULL DEFAULT true');
            await this.reload();
        } catch (e: any) {
            this.logger.warn(`Alert settings table unavailable, using defaults (all on): ${e.message}`);
        }
        this.timer = setInterval(() => void this.reload().catch(() => undefined), 30_000);
        this.timer.unref();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    private async reload() {
        const rows = await this.ds.query('SELECT key, enabled, param, telegram, discord FROM alert_settings');
        const next = new Map<string, Row>();
        for (const r of rows) {
            next.set(r.key, { enabled: !!r.enabled, param: r.param === null ? null : Number(r.param), telegram: !!r.telegram, discord: !!r.discord });
        }
        this.rows = next;
    }

    /** A plain on/off row that ignores the alerts master switch (destinations, Jira). */
    flag(key: string): boolean {
        return this.rows.get(key)?.enabled ?? true;
    }

    /** Master switch off => nothing is sent. Unknown keys are treated as on. */
    isEnabled(key: string): boolean {
        if (!this.flag(MASTER_KEY)) return false;
        return this.flag(key);
    }

    /** Where this alert should go right now: alert on, master on, destination on, and the alert's own destination switch. */
    destinations(key: string): { telegram: boolean; discord: boolean } {
        if (!this.isEnabled(key)) return { telegram: false, discord: false };
        const row = this.rows.get(key);
        return {
            telegram: this.flag(DEST_TELEGRAM) && (row?.telegram ?? true),
            discord: this.flag(DEST_DISCORD) && (row?.discord ?? true),
        };
    }

    /** Current value of an alert's threshold, or its default. */
    param(key: string): number {
        const def = findAlert(key)?.param;
        const v = this.rows.get(key)?.param;
        return v === null || v === undefined ? (def?.default ?? 0) : v;
    }

    list() {
        return {
            master: this.flag(MASTER_KEY),
            telegramEnabled: this.flag(DEST_TELEGRAM),
            discordEnabled: this.flag(DEST_DISCORD),
            jiraEnabled: this.flag(JIRA_CREATE),
            groups: ALERT_GROUPS.map((g) => ({
                ...g,
                alerts: ALERT_CATALOG.filter((a) => a.group === g.id).map((a) => ({
                    key: a.key,
                    label: a.label,
                    description: a.description,
                    enabled: this.rows.get(a.key)?.enabled ?? true,
                    telegram: this.rows.get(a.key)?.telegram ?? true,
                    discord: this.rows.get(a.key)?.discord ?? true,
                    param: a.param ? { ...a.param, value: this.param(a.key) } : null,
                })),
            })),
        };
    }

    async update(key: string, patch: { enabled?: boolean; param?: number; telegram?: boolean; discord?: boolean }, by: string) {
        const isExtra = EXTRA_KEYS.includes(key);
        if (!isExtra && !findAlert(key)) throw new BadRequestException(`Unknown setting "${key}"`);
        if (isExtra && (patch.param !== undefined || patch.telegram !== undefined || patch.discord !== undefined)) {
            throw new BadRequestException('This setting only has an on/off switch');
        }
        const def = findAlert(key)?.param;
        if (patch.param !== undefined) {
            if (!def) throw new BadRequestException('This alert has no threshold');
            if (!Number.isFinite(patch.param) || patch.param < def.min || patch.param > def.max) {
                throw new BadRequestException(`${def.label} must be between ${def.min} and ${def.max}`);
            }
        }
        const current = this.rows.get(key);
        const next: Row = {
            enabled: patch.enabled ?? current?.enabled ?? true,
            param: patch.param ?? current?.param ?? null,
            telegram: patch.telegram ?? current?.telegram ?? true,
            discord: patch.discord ?? current?.discord ?? true,
        };
        await this.ds.query(
            `INSERT INTO alert_settings (key, enabled, param, telegram, discord, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, now(), $6)
             ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, param = EXCLUDED.param, telegram = EXCLUDED.telegram,
                                             discord = EXCLUDED.discord, updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [key, next.enabled, next.param, next.telegram, next.discord, by],
        );
        this.rows.set(key, next);
    }

    /**
     * Switch every alert of a group on or off for ONE destination only (Telegram or Discord), leaving the
     * other destination untouched. Switching on also clears a global mute on those alerts.
     */
    async updateGroupDest(group: AlertGroup, dest: 'telegram' | 'discord', enabled: boolean, by: string) {
        if (!ALERT_GROUPS.some((g) => g.id === group)) throw new BadRequestException(`Unknown group "${group}"`);
        for (const a of ALERT_CATALOG.filter((x) => x.group === group)) {
            await this.update(a.key, enabled ? { [dest]: true, enabled: true } : { [dest]: false }, by);
        }
    }

    /** Switch every alert of a group on or off in one go. */
    async updateGroup(group: AlertGroup, enabled: boolean, by: string) {
        if (!ALERT_GROUPS.some((g) => g.id === group)) throw new BadRequestException(`Unknown group "${group}"`);
        for (const a of ALERT_CATALOG.filter((x) => x.group === group)) await this.update(a.key, { enabled }, by);
    }
}
