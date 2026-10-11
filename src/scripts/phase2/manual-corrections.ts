import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * MANUAL CORRECTIONS (standing rule agreed 2026-10-07): when the legacy ledger has a known data fault that cannot be fixed by a general rule
 * (today: a credit posted to the wrong loan type), it is listed in backend/scripts/legacy-migration/manual-corrections.json, flagged for
 * manual correction, and RE-APPLIED on every re-migration so the fix is never lost. The migrated ledger rows themselves are never changed
 * (the Member Ledger keeps matching the legacy ledger); only the loan records / repayment history take the correction.
 */
export interface ManualCorrection {
    mbno: string; voucher: string; date: string; code: 'A1002' | 'A1047'; amount: number; toCode: 'A1002' | 'A1047'; reason: string;
}
const FILE = resolve(__dirname, '../../../scripts/legacy-migration/manual-corrections.json');
let cache: ManualCorrection[] | null = null;
export function loadManualCorrections(): ManualCorrection[] {
    if (cache) return cache;
    cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf-8')) : [];
    return cache!;
}
export const typeOfCode = (code: string): 'RLN' | 'ALN' => (code === 'A1002' ? 'RLN' : 'ALN');
export const correctionsFor = (mbno: string): ManualCorrection[] => loadManualCorrections().filter(c => String(c.mbno) === String(mbno));
/** What a head's ledger closing balance must be shifted by: a credit moved OFF the head raises it, one moved ONTO the head lowers it. */
export function closingAdjustment(mbno: string, type: 'RLN' | 'ALN'): number {
    let adj = 0;
    for (const c of correctionsFor(mbno)) {
        if (typeOfCode(c.code) === type) adj += c.amount;
        if (typeOfCode(c.toCode) === type) adj -= c.amount;
    }
    return Math.round(adj * 100) / 100;
}
