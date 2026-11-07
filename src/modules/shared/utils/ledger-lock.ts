/**
 * ES-445: one lock for every writer that hands out ledger ids.
 *
 * `ledgerid` and `trans_no` in the ledger table are taken with `SELECT MAX(...) + 1`. That is only safe if every
 * writer takes the SAME lock first; before this helper each service used its own key (or none), so two requests at
 * the same moment read the same MAX and wrote the same ids (confirmed live: 12 parallel receipts produced 24 rows
 * with only 2 distinct ledgerid values).
 *
 * Call this as the first thing after the transaction starts, before reading MAX(ledgerid) / MAX(trans_no) from
 * `ledger`. It is a transaction-level advisory lock: it is released automatically at COMMIT or ROLLBACK, so there is
 * nothing to release by hand. Works with a QueryRunner or an EntityManager (both have `query`).
 */
export const LEDGER_ID_LOCK_KEY = 'ledger.ids';

export async function lockLedgerIds(runner: { query: (sql: string, params?: any[]) => Promise<any> }): Promise<void> {
    await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LEDGER_ID_LOCK_KEY]);
}
