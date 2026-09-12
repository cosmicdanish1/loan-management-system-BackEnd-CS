import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RdRules, RD_RULE_DEFAULTS } from './rd-business-rules';

/**
 * Reads RD business rules from system_configs, falling back to the
 * documented default when a key has never been configured. Shared by every
 * RD service (member config, installments, pattern engine, both interest
 * calculators, FY closing) so they all read the exact same live values —
 * same pattern as loan-eligibility.service.ts's local getRule(), just
 * promoted to an injectable service since multiple RD services need it.
 *
 * Deliberately queries system_configs directly rather than going through
 * SystemConfigService.getConfigValue() (which throws NotFoundException on a
 * key that's simply never been set) — a never-configured RD rule should
 * quietly use its default, not 500 whatever screen touches it first.
 */
@Injectable()
export class RdRulesService {
    private readonly logger = new Logger(RdRulesService.name);

    constructor(private readonly dataSource: DataSource) { }

    async getRule<K extends keyof RdRules>(key: K): Promise<RdRules[K]> {
        const fallback = RD_RULE_DEFAULTS[key];
        try {
            const rows = await this.dataSource.query(
                `SELECT value FROM system_configs WHERE key = $1 AND "isActive" = true LIMIT 1`,
                [key],
            );
            const raw = rows[0]?.value;
            if (raw === undefined || raw === null || raw === '') return fallback;
            if (typeof fallback === 'boolean') {
                return (raw === 'true' || raw === '1' || raw === 'Y') as RdRules[K];
            }
            const n = Number(raw);
            return (Number.isFinite(n) ? n : fallback) as RdRules[K];
        } catch (error: any) {
            this.logger.warn(`Could not read rule ${key}, using default: ${error.message}`);
            return fallback;
        }
    }

    /** All RD rules at once — used by services (like the pattern engine) that
     *  need several of them together for a single evaluation. */
    async getAllRules(): Promise<RdRules> {
        const keys = Object.keys(RD_RULE_DEFAULTS) as Array<keyof RdRules>;
        const entries = await Promise.all(
            keys.map(async (key) => [key, await this.getRule(key)] as const),
        );
        return Object.fromEntries(entries) as unknown as RdRules;
    }
}
