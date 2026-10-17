import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TermsService } from './terms.service';

// Items the person ticks off themselves (the app reports them). The rest are worked out from data.
const MARKABLE = ['profile', 'password', 'tour', 'slides', 'dismissed'];
const WINDOW_RE = /^window:[A-Z0-9_]{2,40}$/;
const WINDOWS_NEEDED = 3;
const MAX_WINDOW_ROWS = 50;

export type ChecklistItemId = 'terms' | 'profile' | 'password' | 'twofa' | 'tour' | 'slides' | 'windows';

export interface ChecklistStatus {
    items: { id: ChecklistItemId; done: boolean }[];
    doneCount: number;
    total: number;
    dismissed: boolean;
    windowsOpened: number;
    windowsNeeded: number;
}

@Injectable()
export class ChecklistService implements OnModuleInit {
    constructor(private readonly ds: DataSource, private readonly terms: TermsService) { }

    // Same tables as database/migrations/create-onboarding-progress-events.sql.
    async onModuleInit() {
        await this.ds.query(`CREATE TABLE IF NOT EXISTS onboarding_progress (
            user_id integer NOT NULL, item varchar(60) NOT NULL, done_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, item))`);
        await this.ds.query(`CREATE TABLE IF NOT EXISTS onboarding_events (
            id bigserial PRIMARY KEY, user_id integer NOT NULL, username varchar(100), event varchar(20) NOT NULL,
            step varchar(50), created_at timestamptz NOT NULL DEFAULT now())`);
        await this.ds.query(`CREATE INDEX IF NOT EXISTS idx_onboarding_events_event_step ON onboarding_events (event, step)`);
        await this.ds.query(`CREATE INDEX IF NOT EXISTS idx_onboarding_events_user ON onboarding_events (user_id)`);
    }

    async status(userId: number): Promise<ChecklistStatus> {
        const [progress, termsStatus, twofa] = await Promise.all([
            this.ds.query(`SELECT item FROM onboarding_progress WHERE user_id = $1`, [userId]),
            this.terms.status(userId),
            this.ds.query(`SELECT totp_enabled FROM usermaster WHERE userid = $1`, [userId]),
        ]);
        const marked = new Set<string>(progress.map((r: any) => r.item));
        const windowsOpened = [...marked].filter((i) => i.startsWith('window:')).length;
        const items: ChecklistStatus['items'] = [
            { id: 'terms', done: termsStatus.accepted },
            { id: 'profile', done: marked.has('profile') },
            { id: 'password', done: marked.has('password') },
            { id: 'twofa', done: !!twofa[0]?.totp_enabled },
            { id: 'tour', done: marked.has('tour') },
            { id: 'slides', done: marked.has('slides') },
            { id: 'windows', done: windowsOpened >= WINDOWS_NEEDED },
        ];
        return {
            items,
            doneCount: items.filter((i) => i.done).length,
            total: items.length,
            dismissed: marked.has('dismissed'),
            windowsOpened,
            windowsNeeded: WINDOWS_NEEDED,
        };
    }

    async mark(userId: number, item: string): Promise<ChecklistStatus> {
        const isWindow = WINDOW_RE.test(item);
        if (!MARKABLE.includes(item) && !isWindow) throw new BadRequestException('Unknown checklist item');
        if (isWindow) {
            // Bounded: a user cannot grow this table without limit by opening many different windows.
            const n = await this.ds.query(`SELECT count(*)::int AS c FROM onboarding_progress WHERE user_id = $1 AND item LIKE 'window:%'`, [userId]);
            if ((n[0]?.c ?? 0) >= MAX_WINDOW_ROWS) return this.status(userId);
        }
        await this.ds.query(
            `INSERT INTO onboarding_progress (user_id, item) VALUES ($1, $2) ON CONFLICT (user_id, item) DO NOTHING`,
            [userId, item],
        );
        return this.status(userId);
    }

    // Brings the checklist back after "hide" (Help > Getting Started).
    async unhide(userId: number): Promise<ChecklistStatus> {
        await this.ds.query(`DELETE FROM onboarding_progress WHERE user_id = $1 AND item = 'dismissed'`, [userId]);
        return this.status(userId);
    }
}
