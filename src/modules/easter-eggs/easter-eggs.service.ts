import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertService } from '../alerts/alert.service';

/** The eggs the app can detect on its own. The ids are fixed: the frontend reports them by name. */
export const EGG_IDS = ['notfound', 'about', 'dayend', 'search', 'konami', 'date'] as const;

export interface EggProgress {
    found: string[];
    total: number;
    completed: boolean;
    completedAt: string | null;
}

const EMPTY: EggProgress = { found: [], total: EGG_IDS.length, completed: false, completedAt: null };

/** Per-user progress of the Easter-egg hunt. Fun feature: it must never throw into a real request. */
@Injectable()
export class EasterEggsService {
    private readonly logger = new Logger(EasterEggsService.name);

    constructor(private readonly db: DataSource, private readonly alerts: AlertService) { }

    private shape(row?: { found: string[]; completed_at: Date | null }): EggProgress {
        if (!row) return { ...EMPTY };
        const found = (row.found ?? []).filter((e) => (EGG_IDS as readonly string[]).includes(e));
        return {
            found,
            total: EGG_IDS.length,
            completed: !!row.completed_at,
            completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        };
    }

    async get(userId: string): Promise<EggProgress> {
        try {
            const rows = await this.db.query(`SELECT found, completed_at FROM easter_egg_progress WHERE user_id = $1`, [userId]);
            return this.shape(rows[0]);
        } catch (e: any) {
            this.logger.warn(`Easter egg progress unavailable: ${e.message}`);
            return { ...EMPTY };
        }
    }

    async markFound(userId: string, displayName: string, egg: string): Promise<EggProgress> {
        if (!(EGG_IDS as readonly string[]).includes(egg)) return this.get(userId);
        try {
            // One atomic upsert: add the egg once, and stamp completed_at the first time the set is full.
            const before = await this.get(userId);
            const rows = await this.db.query(
                `INSERT INTO easter_egg_progress (user_id, display_name, found, completed_at)
                 VALUES ($1, $2, ARRAY[$3]::text[], CASE WHEN $4 <= 1 THEN now() END)
                 ON CONFLICT (user_id) DO UPDATE SET
                    display_name = EXCLUDED.display_name,
                    found = (SELECT ARRAY(SELECT DISTINCT unnest(easter_egg_progress.found || EXCLUDED.found))),
                    completed_at = COALESCE(
                        easter_egg_progress.completed_at,
                        CASE WHEN cardinality((SELECT ARRAY(SELECT DISTINCT unnest(easter_egg_progress.found || EXCLUDED.found)))) >= $4
                             THEN now() END),
                    updated_at = now()
                 RETURNING found, completed_at`,
                [userId, displayName, egg, EGG_IDS.length],
            );
            const row = rows[0];
            if (row?.completed_at && !before.completed) {
                this.alerts.easterEggsCompleted({ username: displayName || userId });
            }
            return this.shape(row);
        } catch (e: any) {
            this.logger.warn(`Easter egg progress not saved: ${e.message}`);
            return { ...EMPTY };
        }
    }
}
