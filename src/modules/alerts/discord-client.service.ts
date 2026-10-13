import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TelegramChannel } from './telegram-client.service';

/** Same five channels as the Telegram topics; each can have its own Discord webhook. */
const WEBHOOK_ENV: Record<TelegramChannel, string> = {
    queries: 'DISCORD_WEBHOOK_QUERIES',
    errors: 'DISCORD_WEBHOOK_ERRORS',
    activity: 'DISCORD_WEBHOOK_ACTIVITY',
    business: 'DISCORD_WEBHOOK_BUSINESS',
    digest: 'DISCORD_WEBHOOK_DIGEST',
};

// Side bar colour of the message card, per channel.
const COLOUR: Record<TelegramChannel, number> = {
    queries: 0x38bdf8,
    errors: 0xf87171,
    activity: 0x34d399,
    business: 0xfbbf24,
    digest: 0xa78bfa,
};

// Only real Discord webhook URLs are accepted (the value comes from .env, but never post anywhere else).
const WEBHOOK_URL = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+(?:\?[\w=&-]*)?$/;

/** The alert messages are written in Telegram's HTML subset; convert that to Discord markdown. */
export function htmlToDiscord(html: string): string {
    return html
        .replace(/<\/?b>/g, '**')
        .replace(/<\/?i>/g, '*')
        .replace(/<\/?code>/g, '`')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * Posts alert messages to Discord channel webhooks (free, no bot needed). A webhook URL per
 * channel goes in .env; DISCORD_WEBHOOK_URL is a single fallback used for every channel that
 * has no URL of its own.
 */
@Injectable()
export class DiscordClientService {
    private readonly logger = new Logger(DiscordClientService.name);

    constructor(private readonly config: ConfigService) { }

    private urlFor(channel: TelegramChannel): string {
        const raw = (this.config.get<string>(WEBHOOK_ENV[channel]) || this.config.get<string>('DISCORD_WEBHOOK_URL') || '').trim();
        if (!raw) return '';
        if (!WEBHOOK_URL.test(raw)) {
            this.logger.warn(`${WEBHOOK_ENV[channel]} is not a Discord webhook URL and is ignored`);
            return '';
        }
        return raw;
    }

    isConfigured(channel: TelegramChannel): boolean {
        return !!this.urlFor(channel);
    }

    /** Which of the five channels have a webhook (for the Settings window). */
    channelsConfigured(): Record<TelegramChannel, boolean> {
        return {
            queries: this.isConfigured('queries'),
            errors: this.isConfigured('errors'),
            activity: this.isConfigured('activity'),
            business: this.isConfigured('business'),
            digest: this.isConfigured('digest'),
        };
    }

    anyConfigured(): boolean {
        return Object.values(this.channelsConfigured()).some(Boolean);
    }

    async send(html: string, channel: TelegramChannel): Promise<void> {
        const url = this.urlFor(channel);
        if (!url) return;
        // First line = card title (bold, with its emoji); the rest = card body.
        const [first, ...rest] = htmlToDiscord(html).split('\n');
        const title = first.replace(/\*\*|`|\*/g, '').trim().slice(0, 250);
        const description = rest.join('\n').trim().slice(0, 4000);
        const body = JSON.stringify({
            username: 'Espat Alerts',
            // Never let message text ping @everyone / roles / users.
            allowed_mentions: { parse: [] },
            embeds: [{
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                color: COLOUR[channel],
                footer: { text: `Espat Society · #${channel}` },
                timestamp: new Date().toISOString(),
            }],
        });

        let lastError = 'unknown error';
        for (let attempt = 1; attempt <= 3; attempt++) {
            let waitMs = attempt * 1500;
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    signal: AbortSignal.timeout(15000),
                });
                if (res.ok) return;
                const detail = await res.text();
                // The webhook URL is a secret: never put it in an error message.
                lastError = `Discord ${res.status}: ${detail.slice(0, 300)}`;
                if (res.status !== 429 && res.status < 500) throw new Error(lastError); // 4xx: retrying will not help
                let retryAfter = 0;
                try { retryAfter = Number(JSON.parse(detail)?.retry_after); } catch { /* not JSON */ }
                if (retryAfter > 0) waitMs = Math.min(retryAfter, 30) * 1000;
            } catch (e: any) {
                if (/^Discord 4/.test(String(e.message)) && !/^Discord 429/.test(String(e.message))) throw e;
                lastError = lastError === 'unknown error' ? `network error (${e.cause?.code || e.name})` : lastError;
            }
            if (attempt < 3) await new Promise((r) => setTimeout(r, waitMs));
        }
        throw new Error(lastError);
    }
}
