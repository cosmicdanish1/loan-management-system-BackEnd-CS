import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

const VERSION_KEY = 'terms.version';
const TEXT_KEY = 'terms.text';

// Placeholder until the client supplies the final wording. Publishing real text with a new
// version (PUT /onboarding/terms) makes every user accept again.
const DEFAULT_VERSION = '1.0-draft';
const DEFAULT_TEXT = `TERMS AND CONDITIONS OF USE (DRAFT)

1. Authorised use
This software is provided for the official work of your society. Use it only for the duties assigned to you and only with the account issued to you.

2. Your account
Keep your password and approval codes private. You are responsible for all activity done with your account. Report any suspected misuse through the Support Desk immediately.

3. Confidential data
Member, loan, deposit and ledger information is confidential. Do not copy, print, export or share it except as your duties require and as the society's rules allow.

4. Accuracy of entries
Check every entry before you save or pass it. Corrections must go through the approved procedure; do not alter records to hide errors.

5. Monitoring
Logins, changes and approvals are recorded in audit logs and may be reviewed by the society and its auditors.

6. Changes to these terms
These terms may be updated. When they are, you will be asked to read and accept the new version before you continue.

By accepting, you confirm that you have read and agree to these terms.`;

export interface TermsStatus {
    version: string;
    accepted: boolean;
    acceptedAt: string | null;
}

@Injectable()
export class TermsService implements OnModuleInit {
    constructor(private readonly ds: DataSource) { }

    // Same table as database/migrations/create-terms-acceptances.sql; created here too so a fresh database just works.
    async onModuleInit() {
        await this.ds.query(`CREATE TABLE IF NOT EXISTS terms_acceptances (
            id SERIAL PRIMARY KEY,
            user_id integer NOT NULL,
            username varchar(100),
            version varchar(30) NOT NULL,
            accepted_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_terms_user_version UNIQUE (user_id, version)
        )`);
        await this.ds.query(`CREATE INDEX IF NOT EXISTS idx_terms_acceptances_version ON terms_acceptances (version)`);
    }

    private async setting(key: string): Promise<string | null> {
        const rows = await this.ds.query(`SELECT "value" FROM system_settings WHERE "key" = $1`, [key]);
        return rows[0]?.value ?? null;
    }

    async getTerms(): Promise<{ version: string; text: string }> {
        const [version, text] = await Promise.all([this.setting(VERSION_KEY), this.setting(TEXT_KEY)]);
        return { version: version || DEFAULT_VERSION, text: text || DEFAULT_TEXT };
    }

    async status(userId: number): Promise<TermsStatus> {
        const { version } = await this.getTerms();
        const rows = await this.ds.query(
            `SELECT accepted_at FROM terms_acceptances WHERE user_id = $1 AND version = $2`, [userId, version]);
        return {
            version,
            accepted: rows.length > 0,
            acceptedAt: rows[0]?.accepted_at ? new Date(rows[0].accepted_at).toISOString() : null,
        };
    }

    // The client sends the version it displayed; if the terms changed meanwhile it must read the new ones.
    async accept(userId: number, username: string | null, version: string): Promise<TermsStatus> {
        const current = await this.getTerms();
        if (version !== current.version) {
            throw new BadRequestException('The terms were updated. Please read the new version and accept again.');
        }
        await this.ds.query(
            `INSERT INTO terms_acceptances (user_id, username, version) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, version) DO NOTHING`,
            [userId, username?.slice(0, 100) ?? null, version],
        );
        return this.status(userId);
    }

    async publish(version: string, text: string): Promise<{ version: string }> {
        const v = version.trim();
        if (!v || !text.trim()) throw new BadRequestException('Version and text are required');
        if ((await this.getTerms()).version === v) {
            throw new BadRequestException('That version already exists. Use a new version number so users are asked to accept again.');
        }
        for (const [key, value] of [[VERSION_KEY, v], [TEXT_KEY, text]]) {
            await this.ds.query(
                `INSERT INTO system_settings ("key","value") VALUES ($1,$2)
                 ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`,
                [key, value],
            );
        }
        return { version: v };
    }
}
