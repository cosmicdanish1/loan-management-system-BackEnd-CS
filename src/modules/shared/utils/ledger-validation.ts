export interface LedgerEntry {
    transType: 'DR' | 'CR';
    amount: number;
}

export interface ValidationResult {
    valid: boolean;
    drTotal: number;
    crTotal: number;
    difference: number;
}

export function validateDoubleEntry(entries: LedgerEntry[]): ValidationResult {
    const drTotal = Math.round(
        entries.filter(e => e.transType === 'DR').reduce((sum, e) => sum + (e.amount || 0), 0) * 100
    ) / 100;

    const crTotal = Math.round(
        entries.filter(e => e.transType === 'CR').reduce((sum, e) => sum + (e.amount || 0), 0) * 100
    ) / 100;

    const difference = Math.round((drTotal - crTotal) * 100) / 100;

    return {
        valid: difference === 0,
        drTotal,
        crTotal,
        difference,
    };
}
