import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Which topic of the alerts group a message belongs to (ids come from .env, see .env.example). */
export type TelegramChannel = 'queries' | 'errors' | 'activity' | 'business' | 'digest';

const TOPIC_ENV: Record<TelegramChannel, string> = {
    queries: 'TELEGRAM_TOPIC_QUERIES',
    errors: 'TELEGRAM_TOPIC_ERRORS',
    activity: 'TELEGRAM_TOPIC_ACTIVITY',
    business: 'TELEGRAM_TOPIC_BUSINESS',
    digest: 'TELEGRAM_TOPIC_DIGEST',
};

/**
 * Cuts HTML text to a length Telegram accepts without leaving a half tag or half entity behind (Telegram answers 400
 * "can't parse entities" and the alert would be lost), and closes any tag that the cut left open (ES-434).
 */
export function safeHtmlCut(text: string, max: number): string {
    if (text.length <= max) return text;
    let cut = text.slice(0, max - 30); // room for the closing tags added below
    const lt = cut.lastIndexOf('<');
    if (lt > cut.lastIndexOf('>')) cut = cut.slice(0, lt); // inside a tag
    const amp = cut.lastIndexOf('&');
    if (amp !== -1 && amp > cut.lastIndexOf(';') && cut.length - amp <= 10) cut = cut.slice(0, amp); // inside an entity
    const open: string[] = [];
    for (const m of cut.matchAll(/<(\/?)(b|i|u|s|code|pre|a)\b[^>]*>/gi)) {
        const name = m[2].toLowerCase();
        if (m[1]) { const at = open.lastIndexOf(name); if (at !== -1) open.splice(at, 1); } else open.push(name);
    }
    return cut + '…' + open.reverse().map((n) => `</${n}>`).join('');
}

/** Sends plain-text messages to the alerts group through the Telegram Bot API. */
@Injectable()
export class TelegramClientService {
    constructor(private readonly config: ConfigService) { }

    isConfigured(): boolean {
        return !!(this.config.get('TELEGRAM_BOT_TOKEN') && this.config.get('TELEGRAM_CHAT_ID'));
    }

    /** Which of the five channels have their own topic id in .env (the rest land in the group's General chat). */
    channelsConfigured(): Record<TelegramChannel, boolean> {
        const has = (c: TelegramChannel) => {
            const n = Number(this.config.get<string>(TOPIC_ENV[c]));
            return Number.isInteger(n) && n > 0;
        };
        return { queries: has('queries'), errors: has('errors'), activity: has('activity'), business: has('business'), digest: has('digest') };
    }

    async send(text: string, channel: TelegramChannel = 'queries', parseMode?: 'HTML'): Promise<void> {
        const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
        const topic = Number(this.config.get<string>(TOPIC_ENV[channel]));
        const body = JSON.stringify({
            chat_id: this.config.get('TELEGRAM_CHAT_ID'),
            // Blank/invalid topic id falls back to the group's General topic.
            ...(Number.isInteger(topic) && topic > 0 ? { message_thread_id: topic } : {}),
            text: parseMode === 'HTML' ? safeHtmlCut(text, 4000) : text.slice(0, 4000),
            ...(parseMode ? { parse_mode: parseMode } : {}),
            disable_web_page_preview: true,
        });

        // The connection to Telegram resets now and then: retry network errors, 429 and 5xx.
        let lastError = 'unknown error';
        for (let attempt = 1; attempt <= 3; attempt++) {
            let waitMs = attempt * 1500;
            try {
                const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    signal: AbortSignal.timeout(15000),
                });
                if (res.ok) return;
                const detail = await res.text();
                // Never include the URL (it contains the bot token) in the error.
                lastError = `Telegram ${res.status}: ${detail.slice(0, 300)}`;
                if (res.status !== 429 && res.status < 500) throw new Error(lastError); // 4xx: retrying will not help
                const retryAfter = Number(JSON.parse(detail)?.parameters?.retry_after);
                if (retryAfter > 0) waitMs = Math.min(retryAfter, 30) * 1000;
            } catch (e: any) {
                if (String(e.message).startsWith('Telegram 4') && !String(e.message).startsWith('Telegram 429')) throw e;
                lastError = lastError === 'unknown error' ? `network error (${e.cause?.code || e.name})` : lastError;
            }
            if (attempt < 3) await new Promise((r) => setTimeout(r, waitMs));
        }
        throw new Error(lastError);
    }
}
