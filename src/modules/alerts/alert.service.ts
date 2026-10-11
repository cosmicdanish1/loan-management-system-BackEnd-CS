import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramChannel, TelegramClientService } from './telegram-client.service';
import { AlertBridge } from './alert-bridge';
import { ClientInfo } from './client-info';

const FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const SEND_SPACING_MS = 3200; // Telegram allows ~20 messages/minute per group
const MAX_QUEUE = 200;
const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const FAILED_LOGIN_ALERT_AT = new Set([3, 10, 25, 50, 100]);

/** HTML-escape anything that came from a user, a URL or an error message. */
export const esc = (s: unknown): string =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const hhmm = (d = new Date()) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const duration = (ms: number): string => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
};

export interface DigestStats {
    logins: number;
    failedLogins: number;
    users: string[];
    errors: number;
    slow: number;
    slowMax: number;
    crashes: number;
    hourly: number[];
    topErrors: Record<string, number>;
}

interface Agg {
    count: number;
    sentCount: number;
    max: number;
    first: Date;
    last: Date;
    users: Set<string>;
    meta: Record<string, string>;
}

/**
 * Builds the human-readable Telegram alerts. Nothing here ever throws or blocks the caller:
 * every public method is fire-and-forget, and repeated problems are grouped into one
 * message plus a periodic "×N more" summary so the group is never flooded.
 *
 * Privacy: messages carry usernames, screens, error types and counts only — never member
 * names, account numbers or amounts.
 */
@Injectable()
export class AlertService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AlertService.name);
    private readonly queue: { channel: TelegramChannel; text: string }[] = [];
    private draining = false;
    private flushTimer?: NodeJS.Timeout;

    private readonly errors = new Map<string, Agg>();
    private readonly slow = new Map<string, Agg>();
    private readonly crashes = new Map<string, Agg>();
    private readonly failedLogins = new Map<string, number[]>();
    private readonly sessions = new Map<string, Date>();

    /** What the daily digest reports. Kept in memory (and saved by the scheduler) because the
     *  access-log table is not written to; reset after each digest. */
    private stats: DigestStats = AlertService.emptyStats();

    static emptyStats(): DigestStats {
        return { logins: 0, failedLogins: 0, users: [], errors: 0, slow: 0, slowMax: 0, crashes: 0, hourly: new Array(24).fill(0), topErrors: {} };
    }

    snapshot(): DigestStats { return JSON.parse(JSON.stringify(this.stats)); }

    restore(s?: DigestStats): void {
        if (s && Array.isArray(s.hourly) && s.hourly.length === 24) this.stats = { ...AlertService.emptyStats(), ...s };
    }

    constructor(
        private readonly config: ConfigService,
        private readonly telegram: TelegramClientService,
    ) { }

    onModuleInit() {
        AlertBridge.set(this);
        this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
        this.flushTimer.unref();
    }

    onModuleDestroy() {
        if (this.flushTimer) clearInterval(this.flushTimer);
    }

    get enabled(): boolean {
        return this.config.get('ALERTS_ENABLED') !== 'false' && this.telegram.isConfigured();
    }

    /** Non-production installs are tagged so test noise is never mistaken for the real thing. */
    private tag(): string {
        const env = this.config.get<string>('ALERT_ENV') || 'dev';
        return env === 'production' ? '' : `<code>[${esc(env)}]</code> `;
    }

    // ───────────────────────── sending ─────────────────────────

    send(channel: TelegramChannel, html: string): void {
        if (!this.enabled) return;
        if (this.queue.length >= MAX_QUEUE) this.queue.shift(); // drop the oldest, never grow unbounded
        this.queue.push({ channel, text: `${this.tag()}${html}` });
        void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length) {
                const item = this.queue.shift()!;
                try {
                    await this.telegram.send(item.text, item.channel, 'HTML');
                } catch (e: any) {
                    this.logger.warn(`Telegram alert not sent: ${e.message}`);
                }
                if (this.queue.length) await new Promise((r) => setTimeout(r, SEND_SPACING_MS));
            }
        } finally {
            this.draining = false;
        }
    }

    // ───────────────────────── errors / slow / crashes ─────────────────────────

    /** A 5xx (or unexpected) backend error. First occurrence is sent at once; repeats are summarised. */
    reportServerError(e: { method: string; route: string; status: number; message: string; user?: string; requestId?: string }): void {
        this.stats.errors++;
        const topKey = `${e.method} ${e.route}`;
        this.stats.topErrors[topKey] = (this.stats.topErrors[topKey] || 0) + 1;
        const message = e.message.replace(/\s+/g, ' ').slice(0, 160);
        const key = `${e.method} ${e.route} ${e.status} ${message}`;
        const agg = this.touch(this.errors, key, e.user, 0, { requestId: e.requestId || '' });
        if (agg.count === 1) {
            agg.sentCount = 1;
            this.send('errors',
                `🔴 <b>Backend error</b>\n<code>${esc(e.method)} ${esc(e.route)} → ${e.status}</code>\n<i>${esc(message)}</i>\n` +
                `${e.user ? `👤 ${esc(e.user)}   ` : ''}🕐 ${hhmm()}${e.requestId ? `\n🔎 request id <code>${esc(e.requestId)}</code>` : ''}`);
        }
    }

    reportSlowCall(e: { method: string; route: string; ms: number; user?: string }): void {
        this.stats.slow++;
        this.stats.slowMax = Math.max(this.stats.slowMax, e.ms);
        const key = `${e.method} ${e.route}`;
        const agg = this.touch(this.slow, key, e.user, e.ms);
        if (agg.count === 1) {
            agg.sentCount = 1;
            this.send('errors',
                `🐢 <b>Slow API</b>  <code>${esc(e.method)} ${esc(e.route)}</code>\n${(e.ms / 1000).toFixed(1)} s${e.user ? `   ·   👤 ${esc(e.user)}` : ''}`);
        }
    }

    /** A crash/error reported by the desktop app through the client-log endpoint. */
    reportClientCrash(e: { host: string; route: string; message: string; user?: string; version?: string }): void {
        this.stats.crashes++;
        const message = e.message.replace(/\s+/g, ' ').slice(0, 200);
        const key = `${e.route} ${message}`;
        const agg = this.touch(this.crashes, key, e.user, 0, { host: e.host, version: e.version || '', route: e.route, message });
        if (agg.count === 1) {
            agg.sentCount = 1;
            this.send('errors',
                `💥 <b>App error</b> in <b>${esc(e.route || 'unknown screen')}</b>\n🖥 ${esc(e.host || 'unknown PC')}${e.version ? `   v${esc(e.version)}` : ''}\n<code>${esc(message)}</code>`);
        }
    }

    private touch(map: Map<string, Agg>, key: string, user: string | undefined, max: number, meta: Record<string, string> = {}): Agg {
        const now = new Date();
        let a = map.get(key);
        if (!a) {
            a = { count: 0, sentCount: 0, max: 0, first: now, last: now, users: new Set(), meta };
            map.set(key, a);
        }
        a.count++;
        a.last = now;
        a.max = Math.max(a.max, max);
        if (user) a.users.add(user);
        return a;
    }

    /** Every 10 minutes: one "×N more" summary per repeating problem, then forget idle ones. */
    private flush(): void {
        const now = Date.now();
        const sweep = (map: Map<string, Agg>, label: (k: string, a: Agg, more: number) => string, channel: TelegramChannel) => {
            for (const [key, a] of map) {
                const more = a.count - a.sentCount;
                if (more > 0) {
                    a.sentCount = a.count;
                    this.send(channel, label(key, a, more));
                } else if (now - a.last.getTime() > 60 * 60 * 1000) {
                    map.delete(key);
                }
            }
        };
        sweep(this.errors, (k, a, more) =>
            `🔴 <b>Backend error ×${a.count}</b> (+${more} in the last 10 min)\n<code>${esc(k.split(' ').slice(0, 3).join(' '))}</code>\n<i>${esc(k.split(' ').slice(3).join(' '))}</i>\n👥 ${a.users.size || 'unknown'} user(s)   🕐 first ${hhmm(a.first)} · last ${hhmm(a.last)}`, 'errors');
        sweep(this.slow, (k, a, more) =>
            `🐢 <b>Slow API ×${a.count}</b> (+${more} in the last 10 min)\n<code>${esc(k)}</code>\nslowest ${(a.max / 1000).toFixed(1)} s`, 'errors');
        sweep(this.crashes, (_k, a, more) =>
            `💥 <b>App error ×${a.count}</b> (+${more} in the last 10 min)\n<b>${esc(a.meta.route || 'unknown screen')}</b>\n<code>${esc(a.meta.message)}</code>\n👥 ${a.users.size || 'unknown'} user(s)`, 'errors');
    }

    // ───────────────────────── login / logout ─────────────────────────

    private where(c: ClientInfo): string {
        const parts = [c.host && `🖥 ${esc(c.host)}`, c.ip && esc(c.ip)].filter(Boolean);
        return parts.length ? parts.join(' · ') : '🖥 unknown PC';
    }

    private extra(c: ClientInfo): string {
        const parts = [c.mac && `🔌 MAC ${esc(c.mac)}`, c.version && `v${esc(c.version)}`, hhmm()].filter(Boolean);
        return parts.join(' · ');
    }

    loginOk(e: { userId: string | number; username: string; role?: string; client: ClientInfo }): void {
        this.failedLogins.delete(`${e.username.toLowerCase()}|${e.client.ip}`);
        this.stats.logins++;
        this.stats.hourly[new Date().getHours()]++;
        if (!this.stats.users.includes(e.username)) this.stats.users.push(e.username);
        this.sessions.set(String(e.userId), new Date());
        this.send('activity',
            `🟢 <b>${esc(e.username)}</b> logged in${e.role ? ` <i>(${esc(String(e.role).toLowerCase())})</i>` : ''}\n${this.where(e.client)}\n${this.extra(e.client)}`);
    }

    logout(e: { userId: string | number; username: string; client: ClientInfo }): void {
        const since = this.sessions.get(String(e.userId));
        this.sessions.delete(String(e.userId));
        this.send('activity',
            `⚪ <b>${esc(e.username)}</b> logged out\n${this.where(e.client)}\n${since ? `⏱ session ${duration(Date.now() - since.getTime())} · ` : ''}${this.extra(e.client)}`);
    }

    /** Alerts on the 3rd failure within 10 minutes (then at 10, 25, 50…) so a typo does not ping you. */
    loginFailed(e: { username: string; client: ClientInfo }): void {
        this.stats.failedLogins++;
        const key = `${e.username.toLowerCase()}|${e.client.ip}`;
        const now = Date.now();
        const hits = (this.failedLogins.get(key) || []).filter((t) => now - t < FAILED_LOGIN_WINDOW_MS);
        hits.push(now);
        this.failedLogins.set(key, hits);
        if (FAILED_LOGIN_ALERT_AT.has(hits.length)) {
            this.send('activity',
                `🔐 <b>${hits.length} failed logins</b> for <code>${esc(e.username || '(blank)')}</code> in 10 min\n${this.where(e.client)}\n${this.extra(e.client)}\nThe account is not locked.`);
        }
    }

    // ───────────────────────── business events ─────────────────────────

    dayEndDone(e: { date: string; seconds: number }): void {
        this.send('business', `✅ <b>Day-end completed</b>  ·  ${esc(e.date)}\n⏱ ${e.seconds} s`);
    }

    dayEndFailed(e: { date: string; error: string }): void {
        this.send('business',
            `❌ <b>Day-end FAILED</b>  ·  ${esc(e.date)}\n<i>${esc(e.error.replace(/\s+/g, ' ').slice(0, 200))}</i>\nEverything was rolled back — nothing was closed, safe to retry.`);
    }

    backupResult(e: { ok: boolean; fileName?: string; sizeBytes?: number; error?: string; type?: string }): void {
        if (e.ok) {
            const mb = e.sizeBytes ? `📦 ${Math.round(e.sizeBytes / 1024 / 1024)} MB` : '';
            this.send('business', `💾 <b>Backup OK</b>  ·  ${hhmm()}\n${mb}${e.type ? `   ${esc(e.type)}` : ''}`);
        } else {
            this.send('business', `🚨 <b>Backup FAILED</b>  ·  ${hhmm()}\n<i>${esc((e.error || 'unknown error').slice(0, 200))}</i>`);
        }
    }

    noRecentBackup(hours: number): void {
        this.send('business', `🚨 <b>No successful backup for ${hours} h</b>\nCheck Utility → Database BackUp.`);
    }

    licenceExpiring(days: number, until: string): void {
        this.send('business',
            `⏳ <b>Licence ${days <= 0 ? 'has expired' : `expires in ${days} day${days === 1 ? '' : 's'}`}</b>\nValid until ${esc(until)}.${days <= 0 ? ' The grace period applies.' : ' Renew to avoid the grace period.'}`);
    }

    /** Returns what the digest counters held and starts a fresh day. */
    takeStats(): DigestStats {
        const s = this.stats;
        this.stats = AlertService.emptyStats();
        return s;
    }
}
