// Member Master rules that the society sets in Modify Business Rules > Operations > Members.
// A limit of 0 means "no limit". They are stored in system_configs and read on every member save, so a change applies at once.

export const MEMBER_RULE_KEYS = [
    'RULE_MEMBER_MIN_AGE',
    'RULE_MEMBER_CD_MIN', 'RULE_MEMBER_CD_MAX',
    'RULE_MEMBER_MD_MIN', 'RULE_MEMBER_MD_MAX',
] as const;

export type MemberRuleKey = typeof MEMBER_RULE_KEYS[number];
export type MemberRules = Record<MemberRuleKey, number>;

/** Minimum age 18 at joining; the deposit ranges are switched off until the society sets them. */
export const MEMBER_RULE_DEFAULTS: MemberRules = {
    RULE_MEMBER_MIN_AGE: 18,
    RULE_MEMBER_CD_MIN: 0, RULE_MEMBER_CD_MAX: 0,
    RULE_MEMBER_MD_MIN: 0, RULE_MEMBER_MD_MAX: 0,
};

/** The stored rules; a missing or unreadable one takes its default (a member save is never blocked by a missing setting). */
export async function loadMemberRules(runner: { query: (sql: string, params?: any[]) => Promise<any> }): Promise<MemberRules> {
    const out: MemberRules = { ...MEMBER_RULE_DEFAULTS };
    try {
        const rows: any[] = await runner.query(
            `SELECT key, value FROM system_configs WHERE key = ANY($1) AND "isActive" IS NOT FALSE`,
            [[...MEMBER_RULE_KEYS]],
        );
        for (const r of rows ?? []) {
            const n = Number(r.value);
            if (Number.isFinite(n) && n >= 0 && (MEMBER_RULE_KEYS as readonly string[]).includes(r.key)) out[r.key as MemberRuleKey] = n;
        }
    } catch { /* defaults */ }
    return out;
}

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Whole years between two YYYY-MM-DD days (null when either is missing or the order is wrong). */
export function wholeYears(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
    const f = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fromIso ?? ''));
    const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(toIso ?? ''));
    if (!f || !t) return null;
    let years = Number(t[1]) - Number(f[1]);
    if (Number(t[2]) < Number(f[2]) || (Number(t[2]) === Number(f[2]) && Number(t[3]) < Number(f[3]))) years--;
    return years;
}

/** The message when a deposit is outside its range, or null when it is fine (0 is a limit that is off; a deposit of 0 is accepted). */
export function rangeProblem(label: string, value: number | null, min: number, max: number): string | null {
    if (value === null || !Number.isFinite(value) || value === 0) return null;
    if (min > 0 && value < min) return `${label} must be in range: at least ₹${fmt(min)}${max > 0 ? ` and at most ₹${fmt(max)}` : ''}.`;
    if (max > 0 && value > max) return `${label} must be in range: ${min > 0 ? `at least ₹${fmt(min)} and ` : ''}at most ₹${fmt(max)}.`;
    return null;
}

/** The message when the member was younger than the minimum on the membership date, or null. */
export function minAgeProblem(dobIso: string | null | undefined, membershipIso: string | null | undefined, minAge: number): string | null {
    if (!(minAge > 0)) return null;
    const age = wholeYears(dobIso, membershipIso);
    if (age === null) return null; // a missing date is the job of the required-field checks; an order problem has its own message
    return age < minAge ? `The member must be at least ${minAge} years old on the membership date (age ${Math.max(age, 0)}).` : null;
}
