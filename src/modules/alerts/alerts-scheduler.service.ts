import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AlertService, DigestStats, esc } from './alert.service';
import { AlertSettingsService } from './alert-settings.service';

interface AlertState {
    lastBackupId?: number;
    lastDigestDate?: string;
    noBackupAlertedOn?: string;
    licenceNotified?: string[];
    stats?: DigestStats;
}

/**
 * Background checks that raise alerts on their own: startup, database reachability, new
 * backups, licence expiry, "no backup for a day", and the morning digest.
 * Every check is wrapped so a failure here can never affect the application.
 */
@Injectable()
export class AlertsSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(AlertsSchedulerService.name);
    private readonly timers: NodeJS.Timeout[] = [];
    private readonly statePath: string;
    private state: AlertState = {};
    private dbDownSince: Date | null = null;
    private dbFailures = 0;

    constructor(
        private readonly alerts: AlertService,
        private readonly ds: DataSource,
        private readonly config: ConfigService,
        private readonly settings: AlertSettingsService,
    ) {
        this.statePath = path.join(this.config.get('LOG_FILE_PATH', './logs'), '.alert-state.json');
    }

    async onApplicationBootstrap() {
        this.loadState();
        this.alerts.restore(this.state.stats);
        this.startupMessage();
        await this.safe(async () => {
            if (this.state.lastBackupId === undefined) {
                const r = await this.ds.query('SELECT COALESCE(MAX(id), 0) AS id FROM backup_log');
                this.state.lastBackupId = Number(r[0].id);
                this.saveState();
            }
        });
        this.every(60_000, () => this.pingDb());
        this.every(120_000, () => this.pollBackups());
        this.every(60 * 60_000, () => this.hourlyChecks(), 5 * 60_000);
        this.every(60_000, () => this.maybeSendDigest());
        this.every(60_000, async () => this.alerts.sweepPresence());
        this.every(60_000, async () => { this.state.stats = this.alerts.snapshot(); this.saveState(); });
    }

    onModuleDestroy() {
        this.timers.forEach(clearInterval);
        this.state.stats = this.alerts.snapshot();
        this.saveState();
    }

    // ───────────────────────── helpers ─────────────────────────

    private every(ms: number, fn: () => Promise<void>, firstAfterMs?: number) {
        const t = setInterval(() => void this.safe(fn), ms);
        t.unref();
        this.timers.push(t);
        if (firstAfterMs) setTimeout(() => void this.safe(fn), firstAfterMs).unref();
    }

    private async safe(fn: () => Promise<void>) {
        try { await fn(); } catch (e: any) { this.logger.warn(`Alert check failed: ${e.message}`); }
    }

    private loadState() {
        try { this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { this.state = {}; }
    }

    private saveState() {
        try {
            fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
            fs.writeFileSync(this.statePath, JSON.stringify(this.state));
        } catch (e: any) { this.logger.warn(`Could not save alert state: ${e.message}`); }
    }

    private todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // ───────────────────────── checks ─────────────────────────

    private startupMessage() {
        let version = process.env.npm_package_version || '';
        try { version = version || JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version; } catch { /* optional */ }
        if (this.config.get('ALERT_STARTUP') === 'false' || !this.settings.isEnabled('system.started')) return;
        this.alerts.send('system.started', 'errors', `✅ <b>Backend started</b>${version ? `  ·  v${esc(version)}` : ''}`);
    }

    /** Two failed pings in a row = down; one alert on the way down, one on recovery. */
    private async pingDb() {
        try {
            await this.ds.query('SELECT 1');
            if (this.dbDownSince) {
                const mins = Math.max(1, Math.round((Date.now() - this.dbDownSince.getTime()) / 60000));
                if (this.settings.isEnabled('system.db')) this.alerts.send('system.db', 'errors', `✅ <b>Database reachable again</b>\nIt was down for about ${mins} min.`);
            }
            this.dbDownSince = null;
            this.dbFailures = 0;
        } catch (e: any) {
            this.dbFailures++;
            if (this.dbFailures === 2 && !this.dbDownSince) {
                this.dbDownSince = new Date();
                if (this.settings.isEnabled('system.db')) this.alerts.send('system.db', 'errors', `🚨 <b>Database not reachable</b>\nThe backend cannot talk to PostgreSQL. Users will see errors until it is back.\n<i>${esc(String(e.message).slice(0, 150))}</i>`);
            }
        }
    }

    private async pollBackups() {
        const rows = await this.ds.query(
            'SELECT id, file_name, file_size, status, error_message, backup_type FROM backup_log WHERE id > $1 ORDER BY id',
            [this.state.lastBackupId ?? 0],
        );
        for (const r of rows) {
            this.alerts.backupResult({
                ok: String(r.status).toLowerCase() === 'success',
                fileName: r.file_name,
                sizeBytes: Number(r.file_size) || undefined,
                error: r.error_message || r.status,
                type: r.backup_type,
            });
            this.state.lastBackupId = Number(r.id);
        }
        if (rows.length) this.saveState();
    }

    private async hourlyChecks() {
        // No successful backup in 26 h (alert once per day).
        const b = await this.ds.query(
            "SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at))) / 3600 AS hrs FROM backup_log WHERE lower(status) = 'success'");
        const hrs = b[0]?.hrs === null || b[0]?.hrs === undefined ? null : Number(b[0].hrs);
        const missingAfter = this.settings.param('backup.missing') || 26;
        if (this.settings.isEnabled('backup.missing') && hrs !== null && hrs > missingAfter && this.state.noBackupAlertedOn !== this.todayKey()) {
            this.alerts.noRecentBackup(Math.floor(hrs));
            this.state.noBackupAlertedOn = this.todayKey();
            this.saveState();
        }

        // Licence: notify once at 30, 7, 1 days and on expiry.
        const l = await this.ds.query(
            "SELECT expires_at FROM license_keys WHERE lower(status::text) = 'active' ORDER BY expires_at DESC LIMIT 1");
        if (l[0]?.expires_at && this.settings.isEnabled('licence.expiry')) {
            const exp = new Date(l[0].expires_at);
            const days = Math.ceil((exp.getTime() - Date.now()) / 86_400_000);
            const done = new Set(this.state.licenceNotified || []);
            const hit = [0, 1, 7, 30].find((t) => days <= t);
            const id = hit === undefined ? '' : `${exp.toISOString().slice(0, 10)}:${hit}`;
            if (hit !== undefined && !done.has(id)) {
                this.alerts.licenceExpiring(days, exp.toISOString().slice(0, 10));
                [0, 1, 7, 30].filter((t) => t >= hit).forEach((t) => done.add(`${exp.toISOString().slice(0, 10)}:${t}`));
                this.state.licenceNotified = [...done];
                this.saveState();
            }
        }
    }

    private async maybeSendDigest() {
        const hour = this.settings.param('digest.daily');
        const now = new Date();
        if (now.getHours() !== hour || this.state.lastDigestDate === this.todayKey() || !this.alerts.enabled || !this.settings.isEnabled('digest.daily')) return;
        this.state.lastDigestDate = this.todayKey();
        this.saveState();
        await this.sendDigest();
    }

    /** Public so an admin trigger or a test can call it. */
    async sendDigest(): Promise<void> {
        const q = (sql: string, p: unknown[] = []) => this.ds.query(sql, p).catch(() => [] as any[]);
        const [support, dayEnd, backup, flags] = await Promise.all([
            q("SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS raised, COUNT(*) FILTER (WHERE status IN ('RESOLVED','CLOSED') AND updated_at > now() - interval '24 hours') AS done, COUNT(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS')) AS open FROM support_queries"),
            q("SELECT status FROM day_end_processes ORDER BY id DESC LIMIT 1"),
            q("SELECT COUNT(*) FILTER (WHERE lower(status)='success') AS ok, COUNT(*) FILTER (WHERE lower(status)<>'success') AS bad FROM backup_log WHERE created_at > now() - interval '24 hours'"),
            q("SELECT COUNT(*) AS n FROM loan_payment_flags WHERE status = 'OPEN'"),
        ]);
        const st = this.alerts.takeStats();
        const n = (r: any[], k = 'n') => Number(r[0]?.[k] ?? 0);
        const busiest = st.hourly.indexOf(Math.max(...st.hourly));
        const topError = Object.entries(st.topErrors).sort((x, y) => y[1] - x[1])[0];
        const date = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
        const lines = [
            `📊 <b>Daily digest</b>  ·  ${esc(date)}`,
            '',
            '<b>Support</b>',
            `🆕 ${n(support, 'raised')} raised · ✅ ${n(support, 'done')} resolved · 📌 ${n(support, 'open')} open`,
            '',
            '<b>Health</b> (since the last digest)',
            `🔴 ${st.errors} errors${topError ? ` (top: <code>${esc(topError[0])}</code> ×${topError[1]})` : ''}`,
            `🐢 ${st.slow} slow calls${st.slow ? ` (slowest ${(st.slowMax / 1000).toFixed(1)} s)` : ''}`,
            `💥 ${st.crashes} app errors reported`,
            '',
            '<b>Usage</b>',
            `👥 ${st.users.length} different users · ${st.logins} logins${st.failedLogins ? ` · ${st.failedLogins} failed` : ''}${st.peakOnline ? ` · peak ${st.peakOnline} online at once` : ''}${st.logins ? ` · busiest hour ${String(busiest).padStart(2, '0')}:00` : ''}`,
            '',
            '<b>Business</b>',
            `${dayEnd[0] ? (String(dayEnd[0].status).toLowerCase() === 'completed' ? '✅ Last day-end completed' : `⚠️ Last day-end: ${esc(dayEnd[0].status)}`) : '— No day-end yet'}`,
            `💾 Backups: ${n(backup, 'ok')} OK${n(backup, 'bad') ? `, ${n(backup, 'bad')} failed` : ''}`,
            `🚩 ${n(flags)} open EMI flags`,
        ];
        this.alerts.send('digest.daily', 'digest', lines.join('\n'));
    }
}
