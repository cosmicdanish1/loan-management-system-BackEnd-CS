import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TermsService } from './terms.service';

const EVENTS = ['start', 'replay', 'dialog_step', 'skip', 'tour_step', 'tour_done', 'slides_done'];

export interface OnboardingReport {
    totalUsers: number;
    started: number;
    completed: number;
    tourDone: number;
    slidesDone: number;
    steps: { step: string; reached: number; skipped: number }[];
    terms: {
        version: string;
        accepted: number;
        pending: { username: string }[];
        pendingTotal: number;
        recent: { username: string; version: string; acceptedAt: string }[];
    };
}

@Injectable()
export class InsightsService {
    constructor(private readonly ds: DataSource, private readonly terms: TermsService) { }

    async record(userId: number, username: string | null, event: string, step?: string): Promise<void> {
        if (!EVENTS.includes(event)) throw new BadRequestException('Unknown event');
        await this.ds.query(
            `INSERT INTO onboarding_events (user_id, username, event, step) VALUES ($1, $2, $3, $4)`,
            [userId, username?.slice(0, 100) ?? null, event, step ? step.slice(0, 50) : null],
        );
    }

    async report(): Promise<OnboardingReport> {
        const { version } = await this.terms.getTerms();
        const one = async (sql: string, p: any[] = []) => Number((await this.ds.query(sql, p))[0]?.c ?? 0);

        const [totalUsers, started, completed, tourDone, slidesDone, accepted, stepRows, pendingRows, recentRows] = await Promise.all([
            one(`SELECT count(*) AS c FROM usermaster WHERE enable_disable = 'E'`),
            one(`SELECT count(DISTINCT user_id) AS c FROM onboarding_events WHERE event = 'start'`),
            one(`SELECT count(*) AS c FROM user_onboarding WHERE completed_at IS NOT NULL`),
            one(`SELECT count(DISTINCT user_id) AS c FROM onboarding_events WHERE event = 'tour_done'`),
            one(`SELECT count(DISTINCT user_id) AS c FROM onboarding_events WHERE event = 'slides_done'`),
            one(`SELECT count(*) AS c FROM terms_acceptances t JOIN usermaster u ON u.userid = t.user_id
                  WHERE t.version = $1 AND u.enable_disable = 'E'`, [version]),
            this.ds.query(
                `SELECT step,
                        count(DISTINCT user_id) FILTER (WHERE event IN ('dialog_step','tour_step')) AS reached,
                        count(*) FILTER (WHERE event = 'skip') AS skipped
                   FROM onboarding_events WHERE step IS NOT NULL GROUP BY step`),
            this.ds.query(
                `SELECT u.susername AS username FROM usermaster u
                  WHERE u.enable_disable = 'E'
                    AND NOT EXISTS (SELECT 1 FROM terms_acceptances t WHERE t.user_id = u.userid AND t.version = $1)
                  ORDER BY u.susername LIMIT 100`, [version]),
            this.ds.query(
                `SELECT username, version, accepted_at FROM terms_acceptances ORDER BY accepted_at DESC LIMIT 30`),
        ]);

        return {
            totalUsers, started, completed, tourDone, slidesDone,
            steps: stepRows.map((r: any) => ({ step: r.step, reached: Number(r.reached), skipped: Number(r.skipped) })),
            terms: {
                version,
                accepted,
                pending: pendingRows.map((r: any) => ({ username: r.username })),
                pendingTotal: Math.max(0, totalUsers - accepted),
                recent: recentRows.map((r: any) => ({
                    username: r.username, version: r.version, acceptedAt: new Date(r.accepted_at).toISOString(),
                })),
            },
        };
    }
}
