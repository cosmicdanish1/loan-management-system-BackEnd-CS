/**
 * Separate duplicate target receipts from the source-supported multiplicity.
 * Callers must only delete `excess` when the receipt fingerprint is known in
 * the source; an unmatched target row requires investigation, not guessing.
 */
export function partitionReplayReceiptCopies<T>(rows: T[], sourceCount: number): { retained: T[]; excess: T[] } {
    const keepCount = Math.max(0, Math.floor(sourceCount));
    return {
        retained: rows.slice(0, keepCount),
        excess: rows.slice(keepCount),
    };
}
