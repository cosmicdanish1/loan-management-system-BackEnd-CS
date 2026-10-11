import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { basename } from 'path';

export interface JiraIssueInput {
    summary: string;
    description: string;
    priority: string; // LOW | MEDIUM | HIGH | CRITICAL
    labels?: string[];
}

const PRIORITY_MAP: Record<string, string> = {
    LOW: 'Low',
    MEDIUM: 'Medium',
    HIGH: 'High',
    CRITICAL: 'Highest',
};

/** Thin wrapper over the Jira Cloud REST API (v3). Credentials come only from .env. */
@Injectable()
export class JiraClientService {
    private readonly logger = new Logger(JiraClientService.name);

    constructor(private readonly config: ConfigService) { }

    isConfigured(): boolean {
        return !!(this.baseUrl && this.config.get('JIRA_EMAIL') && this.config.get('JIRA_API_TOKEN') && this.projectKey);
    }

    private get baseUrl(): string {
        return (this.config.get<string>('JIRA_BASE_URL') || '').replace(/\/+$/, '');
    }

    private get projectKey(): string {
        return this.config.get<string>('JIRA_PROJECT_KEY') || '';
    }

    private get authHeader(): string {
        const raw = `${this.config.get('JIRA_EMAIL')}:${this.config.get('JIRA_API_TOKEN')}`;
        return `Basic ${Buffer.from(raw).toString('base64')}`;
    }

    browseUrl(key: string): string {
        return `${this.baseUrl}/browse/${key}`;
    }

    /** Creates the issue and returns its key (e.g. "ES-31"). Throws with Jira's message on failure. */
    async createIssue(input: JiraIssueInput): Promise<string> {
        const fields: Record<string, any> = {
            project: { key: this.projectKey },
            issuetype: { name: this.config.get('JIRA_ISSUE_TYPE') || 'Task' },
            summary: input.summary.slice(0, 250),
            description: this.toAdf(input.description),
            labels: input.labels || [],
            priority: { name: PRIORITY_MAP[input.priority] || 'Medium' },
        };

        let res = await this.post('/rest/api/3/issue', { fields });
        // Some projects do not put Priority on the create screen: retry once without it.
        if (!res.ok) {
            const text = await res.text();
            if (/priority/i.test(text)) {
                delete fields.priority;
                res = await this.post('/rest/api/3/issue', { fields });
            } else {
                throw new Error(`Jira ${res.status}: ${text.slice(0, 500)}`);
            }
        }
        if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 500)}`);
        const body: any = await res.json();
        return body.key;
    }

    async attachFile(issueKey: string, filePath: string): Promise<void> {
        const buf = await fs.readFile(filePath);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(buf)]), basename(filePath));
        const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`, {
            method: 'POST',
            headers: { Authorization: this.authHeader, 'X-Atlassian-Token': 'no-check' },
            body: form,
        });
        if (!res.ok) throw new Error(`Jira attachment ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    private post(path: string, body: unknown) {
        return fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                Authorization: this.authHeader,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(body),
        });
    }

    /** Jira v3 requires Atlassian Document Format; one paragraph per line. */
    private toAdf(text: string) {
        const paragraphs = text.split(/\r?\n/).map((line) => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : [],
        }));
        return { type: 'doc', version: 1, content: paragraphs };
    }
}
