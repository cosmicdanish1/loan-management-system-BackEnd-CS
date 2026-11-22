import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DatePolicyMode } from '../../shared/utils/posting-date';
import {
    DATE_POLICY_FILE_FORMAT,
    DATE_POLICY_FILE_VERSION,
    DATE_POLICY_KEYS,
    DATE_POLICY_WINDOWS,
} from '../date-policy-windows';

export interface DatePolicyChange { windowKey: string; mode: DatePolicyMode }
export interface DatePolicyRow {
    key: string; label: string; area: string; kind: 'posts' | 'stores'; wired: boolean;
    mode: DatePolicyMode; changedBy: string | null; changedAt: string | null;
}

/**
 * Day End > Date settings: for every window, does it date its entries on the Day-End WORKING date (the default) or on
 * the real date of the day (SYSTEM, Indian time)? The client decides; every change is logged; the whole setting can be
 * exported to a file and imported back, like the Business Rules profile.
 */
@Injectable()
export class DatePolicyService implements OnModuleInit {
    private readonly logger = new Logger(DatePolicyService.name);

    constructor(private readonly dataSource: DataSource) { }

    /** Creates the two small tables on first start (idempotent). A window with no row is WORKING. */
    async onModuleInit(): Promise<void> {
        try {
            await this.dataSource.query(`
                CREATE TABLE IF NOT EXISTS window_date_policy (
                    window_key  VARCHAR(80) PRIMARY KEY,
                    mode        VARCHAR(10) NOT NULL DEFAULT 'WORKING' CHECK (mode IN ('WORKING', 'SYSTEM')),
                    updated_by  VARCHAR(100),
                    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
                )`);
            await this.dataSource.query(`
                CREATE TABLE IF NOT EXISTS window_date_policy_log (
                    id          SERIAL PRIMARY KEY,
                    window_key  VARCHAR(80) NOT NULL,
                    old_mode    VARCHAR(10) NOT NULL,
                    new_mode    VARCHAR(10) NOT NULL,
                    changed_by  VARCHAR(100),
                    changed_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                    source      VARCHAR(10) NOT NULL DEFAULT 'screen'
                )`);
        } catch (e: any) {
            // never block start-up: with no table every window simply stays on the working date
            this.logger.warn(`window_date_policy tables could not be created: ${e.message}`);
        }
    }

    /** Every configurable window with its current mode. */
    async list(): Promise<DatePolicyRow[]> {
        const saved: Array<{ window_key: string; mode: string; updated_by: string | null; updated_at: Date }> =
            await this.dataSource.query(`SELECT window_key, mode, updated_by, updated_at FROM window_date_policy`);
        const byKey = new Map(saved.map((r) => [r.window_key, r]));
        return DATE_POLICY_WINDOWS.map((w) => {
            const s = byKey.get(w.key);
            return {
                ...w,
                mode: String(s?.mode ?? 'WORKING').toUpperCase() === 'SYSTEM' ? 'SYSTEM' : 'WORKING',
                changedBy: s?.updated_by ?? null,
                changedAt: s?.updated_at ? new Date(s.updated_at).toISOString() : null,
            };
        });
    }

    /** Checks a list of changes without writing anything; returns the clean list or throws one message naming every problem. */
    validate(changes: unknown): DatePolicyChange[] {
        if (!Array.isArray(changes)) throw new BadRequestException('"changes" must be a list.');
        const problems: string[] = [];
        const clean: DatePolicyChange[] = [];
        const seen = new Set<string>();
        for (const c of changes as any[]) {
            const key = String(c?.windowKey ?? '');
            const mode = String(c?.mode ?? '').toUpperCase();
            if (!DATE_POLICY_KEYS.has(key)) { problems.push(`Unknown window "${key}".`); continue; }
            if (mode !== 'WORKING' && mode !== 'SYSTEM') { problems.push(`${key}: the mode must be WORKING or SYSTEM.`); continue; }
            if (seen.has(key)) { problems.push(`${key} appears more than once.`); continue; }
            seen.add(key);
            clean.push({ windowKey: key, mode });
        }
        if (problems.length > 0) throw new BadRequestException(problems.join(' '));
        return clean;
    }

    /** Saves the changes (only the ones that really change a window) in one transaction and writes the log. */
    async save(changes: unknown, user: string, source: 'screen' | 'import' = 'screen') {
        const clean = this.validate(changes);
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const current: Array<{ window_key: string; mode: string }> = await queryRunner.query(`SELECT window_key, mode FROM window_date_policy`);
            const currentMap = new Map(current.map((r) => [r.window_key, String(r.mode).toUpperCase()]));
            const applied: Array<{ windowKey: string; from: DatePolicyMode; to: DatePolicyMode }> = [];
            for (const c of clean) {
                const from = (currentMap.get(c.windowKey) ?? 'WORKING') as DatePolicyMode;
                if (from === c.mode) continue;
                await queryRunner.query(
                    `INSERT INTO window_date_policy (window_key, mode, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
                     ON CONFLICT (window_key) DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
                    [c.windowKey, c.mode, user],
                );
                await queryRunner.query(
                    `INSERT INTO window_date_policy_log (window_key, old_mode, new_mode, changed_by, source) VALUES ($1, $2, $3, $4, $5)`,
                    [c.windowKey, from, c.mode, user, source],
                );
                applied.push({ windowKey: c.windowKey, from, to: c.mode });
            }
            await queryRunner.commitTransaction();
            return { success: true, changed: applied.length, unchanged: clean.length - applied.length, applied };
        } catch (e) {
            await queryRunner.rollbackTransaction();
            throw e;
        } finally {
            await queryRunner.release();
        }
    }

    /** The current setting as a file: { format, version, exportedAt, windows: { KEY: 'WORKING' | 'SYSTEM' } }. */
    async exportFile() {
        const rows = await this.list();
        return {
            format: DATE_POLICY_FILE_FORMAT,
            version: DATE_POLICY_FILE_VERSION,
            exportedAt: new Date().toISOString(),
            note: 'Date settings per window. Each value is WORKING (Day-End working date, the default) or SYSTEM (real date of the day, India time). Edit values only; do not rename keys. Windows left out are not changed on import.',
            windows: Object.fromEntries(rows.map((r) => [r.key, r.mode])),
        };
    }

    /**
     * Reads an exported file and works out what it would change, without writing. Strict: a wrong format, a newer version,
     * an unknown window or a bad value rejects the whole file with a plain message.
     */
    async previewImport(file: any) {
        if (!file || typeof file !== 'object' || file.format !== DATE_POLICY_FILE_FORMAT) {
            throw new BadRequestException('This is not a Date settings file (it was not exported from this window).');
        }
        if (typeof file.version !== 'number' || file.version > DATE_POLICY_FILE_VERSION) {
            throw new BadRequestException(`This file is from a newer version of the format (${String(file.version)}). Update the application first.`);
        }
        if (!file.windows || typeof file.windows !== 'object' || Array.isArray(file.windows)) {
            throw new BadRequestException('The file has no "windows" section.');
        }
        const changes = this.validate(Object.entries(file.windows).map(([windowKey, mode]) => ({ windowKey, mode })));
        const current = new Map((await this.list()).map((r) => [r.key, r.mode]));
        const label = new Map(DATE_POLICY_WINDOWS.map((w) => [w.key, w.label]));
        const willChange = changes
            .filter((c) => current.get(c.windowKey) !== c.mode)
            .map((c) => ({ windowKey: c.windowKey, label: label.get(c.windowKey)!, from: current.get(c.windowKey)!, to: c.mode }));
        return { changes, willChange, unchanged: changes.length - willChange.length };
    }

    /** The change log, newest first. */
    async history(limit = 100) {
        const n = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 100, 1), 500);
        return this.dataSource.query(
            `SELECT window_key AS "windowKey", old_mode AS "from", new_mode AS "to", changed_by AS "changedBy", changed_at AS "changedAt", source
               FROM window_date_policy_log ORDER BY id DESC LIMIT $1`, [n]);
    }
}
