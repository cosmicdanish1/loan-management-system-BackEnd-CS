import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

// first  = only until the user has finished/skipped it once
// always = on every login
// never  = never auto-start (Help > Replay Tour still works)
export type OnboardingMode = 'first' | 'always' | 'never';
export type UserOnboardingMode = OnboardingMode | 'default';

const MODES: OnboardingMode[] = ['first', 'always', 'never'];
const USER_MODES: UserOnboardingMode[] = ['default', ...MODES];
const GLOBAL_KEY = 'onboarding.mode';

export interface OnboardingStatus {
    shouldShow: boolean;
    effectiveMode: OnboardingMode;
    globalMode: OnboardingMode;
    userMode: UserOnboardingMode;
    completedAt: string | null;
    lastStep: string | null;
}

export interface OnboardingProfile {
    username: string;
    fullName: string;
    email: string | null;
    role: string | null;
    avatar: string | null;
    memberSince: string | null;
    lastLogin: string | null;
}

@Injectable()
export class OnboardingService implements OnModuleInit {
    constructor(private readonly ds: DataSource) { }

    // Same table as database/migrations/create-user-onboarding.sql; created here too so a fresh database just works.
    async onModuleInit() {
        await this.ds.query(`CREATE TABLE IF NOT EXISTS user_onboarding (
            user_id integer PRIMARY KEY,
            mode_override varchar(10) NOT NULL DEFAULT 'default',
            completed_at timestamptz,
            last_seen_version varchar(50),
            last_step varchar(40),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT chk_user_onboarding_mode CHECK (mode_override IN ('default','first','always','never'))
        )`);
        await this.ds.query(`CREATE TABLE IF NOT EXISTS system_settings (
            "key" varchar PRIMARY KEY, "value" text,
            "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now()
        )`);
    }

    // Read-only summary for the welcome profile card.
    async getProfile(userId: number): Promise<OnboardingProfile | null> {
        const rows = await this.ds.query(
            `SELECT u.susername, u.first_name, u.last_name, u.email, u.avatar, u.date_of_creation, l.userlevel
               FROM usermaster u LEFT JOIN userlevelmaster l ON l.userlevelid = u.userlevelid
              WHERE u.userid = $1`,
            [userId],
        );
        const u = rows[0];
        if (!u) return null;
        // logintime holds the CURRENT login too (and writes each login twice, a few ms apart), so
        // "last login" is the newest one that is clearly older than the newest of all.
        const prev = await this.ds.query(
            `SELECT max(login_date) AS d FROM logintime
              WHERE userid = $1 AND login_date < (SELECT max(login_date) FROM logintime WHERE userid = $1) - interval '5 seconds'`,
            [userId],
        );
        const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
        return {
            username: u.susername,
            fullName: fullName || u.susername,
            email: u.email || null,
            role: u.userlevel ? String(u.userlevel).trim() : null,
            avatar: u.avatar || null,
            memberSince: u.date_of_creation ? new Date(u.date_of_creation).toISOString() : null,
            lastLogin: prev[0]?.d ? new Date(prev[0].d).toISOString() : null,
        };
    }

    async getGlobalMode(): Promise<OnboardingMode> {
        const rows = await this.ds.query(`SELECT "value" FROM system_settings WHERE "key" = $1`, [GLOBAL_KEY]);
        const v = rows[0]?.value;
        return MODES.includes(v) ? v : 'first';
    }

    async setGlobalMode(mode: string): Promise<{ globalMode: OnboardingMode }> {
        if (!MODES.includes(mode as OnboardingMode)) throw new BadRequestException('mode must be first, always or never');
        await this.ds.query(
            `INSERT INTO system_settings ("key","value") VALUES ($1,$2)
             ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`,
            [GLOBAL_KEY, mode],
        );
        return { globalMode: mode as OnboardingMode };
    }

    async getStatus(userId: number): Promise<OnboardingStatus> {
        const [globalMode, rows] = await Promise.all([
            this.getGlobalMode(),
            this.ds.query(`SELECT mode_override, completed_at, last_step FROM user_onboarding WHERE user_id = $1`, [userId]),
        ]);
        const row = rows[0];
        const userMode: UserOnboardingMode = row?.mode_override ?? 'default';
        const effectiveMode: OnboardingMode = userMode === 'default' ? globalMode : userMode;
        const completedAt = row?.completed_at ? new Date(row.completed_at).toISOString() : null;
        const shouldShow = effectiveMode === 'always' || (effectiveMode === 'first' && !completedAt);
        return { shouldShow, effectiveMode, globalMode, userMode, completedAt, lastStep: row?.last_step ?? null };
    }

    // Finished or skipped: either way the "first login" is used up.
    async complete(userId: number, version?: string): Promise<OnboardingStatus> {
        await this.ds.query(
            `INSERT INTO user_onboarding (user_id, completed_at, last_seen_version, last_step)
             VALUES ($1, now(), $2, NULL)
             ON CONFLICT (user_id) DO UPDATE SET completed_at = now(),
                last_seen_version = COALESCE($2, user_onboarding.last_seen_version),
                last_step = NULL, updated_at = now()`,
            [userId, version?.slice(0, 50) ?? null],
        );
        return this.getStatus(userId);
    }

    // Remembers where a half-finished tour stopped so it can resume (used by the tour story).
    async saveStep(userId: number, step: string): Promise<void> {
        await this.ds.query(
            `INSERT INTO user_onboarding (user_id, last_step) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET last_step = EXCLUDED.last_step, updated_at = now()`,
            [userId, step.slice(0, 40)],
        );
    }

    async setUserMode(userId: number, mode: string): Promise<OnboardingStatus> {
        if (!USER_MODES.includes(mode as UserOnboardingMode)) throw new BadRequestException('mode must be default, first, always or never');
        await this.ds.query(
            `INSERT INTO user_onboarding (user_id, mode_override) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET mode_override = EXCLUDED.mode_override, updated_at = now()`,
            [userId, mode],
        );
        return this.getStatus(userId);
    }
}
