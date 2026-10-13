import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramChannel, TelegramClientService } from './telegram-client.service';
import { AlertSettingsService } from './alert-settings.service';
import { DiscordClientService } from './discord-client.service';
import { AlertBridge } from './alert-bridge';
import { ClientInfo } from './client-info';

const FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const SEND_SPACING_MS = 3200; // Telegram allows ~20 messages/minute per group
const MAX_QUEUE = 200;
const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;

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
    peakOnline: number;
}

interface Presence {
    userId: string;
    username: string;
    role?: string;
    host: string;
    ip: string;
    mac: string;
    version: string;
    since: Date;
    last: Date;
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
    private readonly queue: { channel: TelegramChannel; text: string; tg: boolean; dc: boolean }[] = [];
    private draining = false;
    private flushTimer?: NodeJS.Timeout;

    private readonly errors = new Map<string, Agg>();
    private readonly slow = new Map<string, Agg>();
    private readonly crashes = new Map<string, Agg>();
    private readonly failedLogins = new Map<string, number[]>();
    private readonly sessions = new Map<string, Date>();
    /** Who is online: one entry per user per PC, kept alive by the app's heartbeat. */
    private readonly presence = new Map<string, Presence>();

    /** What the daily digest reports. Kept in memory (and saved by the scheduler) because the
     *  access-log table is not written to; reset after each digest. */
    private stats: DigestStats = AlertService.emptyStats();

    static emptyStats(): DigestStats {
        return { logins: 0, failedLogins: 0, users: [], errors: 0, slow: 0, slowMax: 0, crashes: 0, hourly: new Array(24).fill(0), topErrors: {}, peakOnline: 0 };
    }

    snapshot(): DigestStats { return JSON.parse(JSON.stringify(this.stats)); }

    restore(s?: DigestStats): void {
        if (s && Array.isArray(s.hourly) && s.hourly.length === 24) this.stats = { ...AlertService.emptyStats(), ...s };
    }

    constructor(
        private readonly config: ConfigService,
        private readonly telegram: TelegramClientService,
        private readonly settings: AlertSettingsService,
        private readonly discord: DiscordClientService,
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
        return this.config.get('ALERTS_ENABLED') !== 'false' && (this.telegram.isConfigured() || this.discord.anyConfigured());
    }

    /** Is this alert switched on in Settings (and the master switch on)? */
    private on(key: string): boolean {
        return this.settings.isEnabled(key);
    }

    /** Slow-call limit in ms, from Settings (falls back to the .env default). */
    slowThresholdMs(): number {
        return this.settings.param('error.slow') * 1000 || Number(this.config.get('SLOW_API_MS')) || 5000;
    }

    /** Sends one test message per channel to a destination, ignoring the alert switches, so Settings can prove the link works. */
    async sendTest(dest: 'telegram' | 'discord'): Promise<number> {
        const channels: [TelegramChannel, string][] = [['queries', 'Queries & Jira'], ['errors', 'Errors & Crashes'], ['activity', 'Activity'], ['business', 'Business events'], ['digest', 'Daily digest']];
        let sent = 0;
        for (const [channel, name] of channels) {
            const text = `${this.tag()}✅ <b>Test message</b> from Settings → Notifications\nThis is the <b>${esc(name)}</b> channel.`;
            try {
                if (dest === 'telegram') {
                    if (!this.telegram.isConfigured()) return 0;
                    await this.telegram.send(text, channel, 'HTML');
                } else {
                    if (!this.discord.isConfigured(channel)) continue;
                    await this.discord.send(text, channel);
                }
                sent++;
            } catch (e: any) { this.logger.warn(`Test message failed for ${name}: ${e.message}`); }
            await new Promise((r) => setTimeout(r, dest === 'telegram' ? SEND_SPACING_MS : 700));
        }
        return sent;
    }

    /** Non-production installs are tagged so test noise is never mistaken for the real thing. */
    private tag(): string {
        const env = this.config.get<string>('ALERT_ENV') || 'dev';
        return env === 'production' ? '' : `<code>[${esc(env)}]</code> `;
    }

    // ───────────────────────── sending ─────────────────────────

    /**
     * Queue one alert. `key` is the alert's catalogue key: the Settings switches decide whether it
     * goes out, and to Telegram, Discord or both. A destination that is not configured is skipped.
     */
    send(key: string, channel: TelegramChannel, html: string, only?: 'discord' | 'telegram'): void {
        if (this.config.get('ALERTS_ENABLED') === 'false') return;
        const d = this.settings.destinations(key);
        const tg = d.telegram && only !== 'discord' && this.telegram.isConfigured();
        const dc = d.discord && only !== 'telegram' && this.discord.isConfigured(channel);
        if (!tg && !dc) return;
        if (this.queue.length >= MAX_QUEUE) this.queue.shift(); // drop the oldest, never grow unbounded
        this.queue.push({ channel, text: `${this.tag()}${html}`, tg, dc });
        void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length) {
                const item = this.queue.shift()!;
                if (item.tg) {
                    try {
                        await this.telegram.send(item.text, item.channel, 'HTML');
                    } catch (e: any) {
                        this.logger.warn(`Telegram alert not sent: ${e.message}`);
                    }
                }
                if (item.dc) {
                    try {
                        await this.discord.send(item.text, item.channel);
                    } catch (e: any) {
                        this.logger.warn(`Discord alert not sent: ${e.message}`);
                    }
                }
                // Telegram allows ~20 messages a minute per group; Discord needs far less spacing.
                if (this.queue.length) await new Promise((r) => setTimeout(r, item.tg ? SEND_SPACING_MS : 700));
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
        if (!this.on('error.backend')) return;
        const message = e.message.replace(/\s+/g, ' ').slice(0, 160);
        const key = `${e.method} ${e.route} ${e.status} ${message}`;
        const agg = this.touch(this.errors, key, e.user, 0, { requestId: e.requestId || '' });
        if (agg.count === 1) {
            agg.sentCount = 1;
            this.send('error.backend', 'errors',
                `🔴 <b>Backend error</b>\n<code>${esc(e.method)} ${esc(e.route)} → ${e.status}</code>\n<i>${esc(message)}</i>\n` +
                `${e.user ? `👤 ${esc(e.user)}   ` : ''}🕐 ${hhmm()}${e.requestId ? `\n🔎 request id <code>${esc(e.requestId)}</code>` : ''}`);
        }
    }

    reportSlowCall(e: { method: string; route: string; ms: number; user?: string }): void {
        this.stats.slow++;
        this.stats.slowMax = Math.max(this.stats.slowMax, e.ms);
        if (!this.on('error.slow')) return;
        const key = `${e.method} ${e.route}`;
        const agg = this.touch(this.slow, key, e.user, e.ms);
        if (agg.count === 1) {
            agg.sentCount = 1;
            this.send('error.slow', 'errors',
                `🐢 <b>Slow API</b>  <code>${esc(e.method)} ${esc(e.route)}</code>\n${(e.ms / 1000).toFixed(1)} s${e.user ? `   ·   👤 ${esc(e.user)}` : ''}`);
        }
    }

    /** A crash/error reported by the desktop app through the client-log endpoint. */
    reportClientCrash(e: { host: string; route: string; message: string; user?: string; version?: string }): void {
        this.stats.crashes++;
        if (!this.on('error.client')) return;
        const message = e.message.replace(/\s+/g, ' ').slice(0, 200);
        const key = `${e.route} ${message}`;
        const agg = this.touch(this.crashes, key, e.user, 0, { host: e.host, version: e.version || '', route: e.route, message });
        if (agg.count === 1) {
            agg.sentCount = 1;
            this.send('error.client', 'errors',
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
        const sweep = (map: Map<string, Agg>, label: (k: string, a: Agg, more: number) => string, channel: TelegramChannel, alertKey: string) => {
            for (const [key, a] of map) {
                const more = a.count - a.sentCount;
                if (more > 0) {
                    a.sentCount = a.count;
                    if (this.on(alertKey)) this.send(alertKey, channel, label(key, a, more));
                } else if (now - a.last.getTime() > 60 * 60 * 1000) {
                    map.delete(key);
                }
            }
        };
        sweep(this.errors, (k, a, more) =>
            `🔴 <b>Backend error ×${a.count}</b> (+${more} in the last 10 min)\n<code>${esc(k.split(' ').slice(0, 3).join(' '))}</code>\n<i>${esc(k.split(' ').slice(3).join(' '))}</i>\n👥 ${a.users.size || 'unknown'} user(s)   🕐 first ${hhmm(a.first)} · last ${hhmm(a.last)}`, 'errors', 'error.backend');
        sweep(this.slow, (k, a, more) =>
            `🐢 <b>Slow API ×${a.count}</b> (+${more} in the last 10 min)\n<code>${esc(k)}</code>\nslowest ${(a.max / 1000).toFixed(1)} s`, 'errors', 'error.slow');
        sweep(this.crashes, (_k, a, more) =>
            `💥 <b>App error ×${a.count}</b> (+${more} in the last 10 min)\n<b>${esc(a.meta.route || 'unknown screen')}</b>\n<code>${esc(a.meta.message)}</code>\n👥 ${a.users.size || 'unknown'} user(s)`, 'errors', 'error.client');
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
        this.touchPresence(e);
        if (!this.on('login.success')) return;
        this.send('login.success', 'activity',
            `🟢 <b>${esc(e.username)}</b> logged in${e.role ? ` <i>(${esc(String(e.role).toLowerCase())})</i>` : ''}\n${this.where(e.client)}\n${this.extra(e.client)}`);
    }

    logout(e: { userId: string | number; username: string; client: ClientInfo }): void {
        const since = this.sessions.get(String(e.userId));
        this.sessions.delete(String(e.userId));
        this.dropPresence(e.userId, e.client);
        if (!this.on('logout')) return;
        this.send('logout', 'activity',
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
        // First alert at the threshold from Settings, then every 10 more attempts.
        const limit = this.settings.param('login.failed') || 3;
        const fire = hits.length === limit || (hits.length > limit && (hits.length - limit) % 10 === 0);
        if (fire && this.on('login.failed')) {
            this.send('login.failed', 'activity',
                `🔐 <b>${hits.length} failed logins</b> for <code>${esc(e.username || '(blank)')}</code> in 10 min\n${this.where(e.client)}\n${this.extra(e.client)}\nThe account is not locked.`);
        }
    }

    // ───────────────────────── presence (who is online) ─────────────────────────

    private touchPresence(e: { userId: string | number; username: string; role?: string; client: ClientInfo }): void {
        const key = `${e.userId}|${e.client.host || e.client.ip || 'unknown'}`;
        const now = new Date();
        const cur = this.presence.get(key);
        if (cur) {
            cur.last = now;
            cur.ip = e.client.ip || cur.ip;
            cur.mac = e.client.mac || cur.mac;
            cur.version = e.client.version || cur.version;
            if (e.role) cur.role = e.role;
        } else {
            this.presence.set(key, {
                userId: String(e.userId), username: e.username, role: e.role,
                host: e.client.host, ip: e.client.ip, mac: e.client.mac, version: e.client.version,
                since: this.sessions.get(String(e.userId)) ?? now, last: now,
            });
        }
        this.stats.peakOnline = Math.max(this.stats.peakOnline || 0, this.presence.size);
    }

    /** Called by the app every minute while a user is signed in. */
    heartbeat(e: { userId: string | number; username: string; role?: string; client: ClientInfo }): void {
        this.touchPresence(e);
    }

    /** A clean logout: remove that PC (or every PC of the user when the PC is unknown). */
    private dropPresence(userId: string | number, client: ClientInfo): void {
        for (const [key, p] of this.presence) {
            if (p.userId !== String(userId)) continue;
            if (!client.host || p.host === client.host) this.presence.delete(key);
        }
    }

    /** Everyone currently online, longest-connected first. */
    onlineNow() {
        const now = Date.now();
        return [...this.presence.values()]
            .sort((a, b) => a.since.getTime() - b.since.getTime())
            .map((p) => ({
                username: p.username, role: p.role || '', host: p.host, ip: p.ip, mac: p.mac, version: p.version,
                since: p.since.toISOString(), lastSeen: p.last.toISOString(),
                minutes: Math.max(0, Math.round((now - p.since.getTime()) / 60000)),
            }));
    }

    /** Every minute (scheduler): anyone silent for longer than the Settings limit has gone offline. */
    sweepPresence(): void {
        const minutes = this.settings.param('presence.offline') || 3;
        const now = Date.now();
        for (const [key, p] of this.presence) {
            if (now - p.last.getTime() <= minutes * 60_000) continue;
            this.presence.delete(key);
            if (![...this.presence.values()].some((x) => x.userId === p.userId)) this.sessions.delete(p.userId);
            if (!this.on('presence.offline')) continue;
            const where = this.where({ ip: p.ip, host: p.host, mac: p.mac, version: p.version });
            this.send('presence.offline', 'activity',
                `⚪ <b>${esc(p.username)}</b> went offline (no signal for ${minutes} min)\n${where}\n⏱ was online ${duration(p.last.getTime() - p.since.getTime())} · ${hhmm()}`);
        }
    }

    /** The "Post to channels" button in Settings. Returns how many people are online. */
    sendOnlineSnapshot(): number {
        const list = this.onlineNow();
        const lines = list.length
            ? list.map((u) => `• <b>${esc(u.username)}</b> — ${duration(u.minutes * 60_000)}${u.host ? ` · ${esc(u.host)}` : ''}`)
            : ['Nobody is signed in right now.'];
        this.send('presence.online', 'activity', `👥 <b>Online now (${list.length})</b>  ·  ${hhmm()}\n${lines.join('\n')}`);
        return list.length;
    }

    // ───────────────────────── admin changes ─────────────────────────

    private by(by: string): string {
        return `by <b>${esc(by || 'unknown')}</b> · ${hhmm()}`;
    }

    userCreated(e: { by: string; username: string; role?: string }): void {
        if (!this.on('admin.user')) return;
        this.send('admin.user', 'activity', `🛠 <b>User created</b>\n👤 <b>${esc(e.username)}</b>${e.role ? ` <i>(${esc(String(e.role).toLowerCase())})</i>` : ''}\n${this.by(e.by)}`);
    }

    userChanged(e: { by: string; username: string; changes: string[] }): void {
        if (!this.on('admin.user') || e.changes.length === 0) return;
        this.send('admin.user', 'activity', `🛠 <b>User changed</b>\n👤 <b>${esc(e.username)}</b>: ${esc(e.changes.join(', '))}\n${this.by(e.by)}`);
    }

    userDeleted(e: { by: string; username: string }): void {
        if (!this.on('admin.user')) return;
        this.send('admin.user', 'activity', `🗑 <b>User deleted</b>\n👤 <b>${esc(e.username)}</b>\n${this.by(e.by)}`);
    }

    rightsChanged(e: { by: string; level: string; added: number; removed: number; total: number }): void {
        if (!this.on('admin.rights')) return;
        this.send('admin.rights', 'activity', `🛡 <b>Rights changed</b> for level <b>${esc(e.level)}</b>\n+${e.added} added · −${e.removed} removed · ${e.total} menu items now allowed\n${this.by(e.by)}`);
    }

    passwordChanged(e: { by: string; username: string; self: boolean }): void {
        if (!this.on('admin.password')) return;
        this.send('admin.password', 'activity', e.self
            ? `🔑 <b>Password changed</b>\n👤 <b>${esc(e.username)}</b> changed their own password\n⏱ ${hhmm()}`
            : `🔑 <b>Password reset</b>\n👤 <b>${esc(e.username)}</b>'s password was reset\n${this.by(e.by)}`);
    }

    // ───────────────────────── business events ─────────────────────────

    dayEndDone(e: { date: string; seconds: number }): void {
        if (!this.on('dayend.done')) return;
        this.send('dayend.done', 'business', `✅ <b>Day-end completed</b>  ·  ${esc(e.date)}\n⏱ ${e.seconds} s`);
    }

    dayEndFailed(e: { date: string; error: string }): void {
        if (!this.on('dayend.failed')) return;
        this.send('dayend.failed', 'business',
            `❌ <b>Day-end FAILED</b>  ·  ${esc(e.date)}\n<i>${esc(e.error.replace(/\s+/g, ' ').slice(0, 200))}</i>\nEverything was rolled back — nothing was closed, safe to retry.`);
    }

    backupResult(e: { ok: boolean; fileName?: string; sizeBytes?: number; error?: string; type?: string }): void {
        if (!this.on(e.ok ? 'backup.ok' : 'backup.failed')) return;
        if (e.ok) {
            const mb = e.sizeBytes ? `📦 ${Math.round(e.sizeBytes / 1024 / 1024)} MB` : '';
            this.send('backup.ok', 'business', `💾 <b>Backup OK</b>  ·  ${hhmm()}\n${mb}${e.type ? `   ${esc(e.type)}` : ''}`);
        } else {
            this.send('backup.failed', 'business', `🚨 <b>Backup FAILED</b>  ·  ${hhmm()}\n<i>${esc((e.error || 'unknown error').slice(0, 200))}</i>`);
        }
    }

    noRecentBackup(hours: number): void {
        if (!this.on('backup.missing')) return;
        this.send('backup.missing', 'business', `🚨 <b>No successful backup for ${hours} h</b>\nCheck Utility → Database BackUp.`);
    }

    licenceExpiring(days: number, until: string): void {
        if (!this.on('licence.expiry')) return;
        this.send('licence.expiry', 'business',
            `⏳ <b>Licence ${days <= 0 ? 'has expired' : `expires in ${days} day${days === 1 ? '' : 's'}`}</b>\nValid until ${esc(until)}.${days <= 0 ? ' The grace period applies.' : ' Renew to avoid the grace period.'}`);
    }

    /** Returns what the digest counters held and starts a fresh day. */
    takeStats(): DigestStats {
        const s = this.stats;
        this.stats = AlertService.emptyStats();
        return s;
    }
}
