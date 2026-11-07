/**
 * ES-506: the interest and penal rate a loan gets when nobody overrides them at sanction — the loan type's card in
 * Business Rules (busrules.{rln|aln|eln}rate / {type}penalrate). This is the same rule Pass Transaction applies when the
 * loan is paid out, kept in one place so the Sanction screen can show exactly what will be used.
 */
export interface RateDefaults {
    rate: number;
    penalRate: number;
}

/** Highest rate / penal % a sanctioning officer may type for one loan. */
export const MAX_OVERRIDE_PERCENT = 36;

const RATE_COLUMN: Record<string, string> = { RLN: 'rlnrate', ALN: 'alnrate', ELN: 'elnrate' };
const KNOWN_PENAL_PREFIXES = ['rln', 'eln', 'aln', 'edl', 'fln'];

export function penalPrefixForLoanType(loanType: string): string {
    const upper = String(loanType || '').toUpperCase();
    const prefix = upper.toLowerCase();
    if (KNOWN_PENAL_PREFIXES.includes(prefix)) return prefix;
    return (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes(upper) || upper.includes('EMERGENCY')) ? 'aln' : 'rln';
}

/**
 * @param systemRate the old system-config rate (RULE_LOAN_LT_INTEREST_RATE / RULE_LOAN_EL_INTEREST_RATE) used when the
 *                   card is empty; 12 when it cannot be read.
 */
export async function resolveLoanRateDefaults(
    runner: { query: (sql: string, params?: any[]) => Promise<any> },
    loanType: string,
    systemRate?: number,
): Promise<RateDefaults> {
    let rate = Number.isFinite(Number(systemRate)) && Number(systemRate) > 0 ? Number(systemRate) : 12;
    let penalRate = 2;

    const upper = String(loanType || '').toUpperCase();
    const rateColumn = RATE_COLUMN[upper];
    if (rateColumn) {
        if (rateColumn === 'elnrate') rate = 9;
        try {
            const rows = await runner.query(`SELECT ${rateColumn} AS card_rate FROM busrules ORDER BY appdate DESC LIMIT 1`);
            const card = parseFloat(rows?.[0]?.card_rate);
            if (!isNaN(card) && card > 0) rate = card;
        } catch { /* keep the fallback */ }
    }

    try {
        const prefix = penalPrefixForLoanType(upper);
        const rows = await runner.query(`SELECT ${prefix}penalrate AS card_penal FROM busrules ORDER BY appdate DESC LIMIT 1`);
        const card = parseFloat(rows?.[0]?.card_penal);
        if (!isNaN(card) && card > 0) penalRate = card;
    } catch { /* keep the fallback */ }

    return { rate, penalRate };
}
