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

/**
 * ES-495: the same idea for the other tables whose ids are taken with SELECT MAX(col) + 1 (transactions.trans_no,
 * vouchers.id). Every writer must use this helper, so they all take the SAME lock key `<table>.<col>`. (Before,
 * the receipt/payment voucher path took no lock on transactions at all and a different key on vouchers than the
 * voucher service, so two vouchers staged at the same moment could get the same trans_no.) The lock is released at
 * COMMIT / ROLLBACK. For the ledger table it also takes the shared ledger id lock.
 */
export async function lockNextId(runner: { query: (sql: string, params?: any[]) => Promise<any> }, table: string, col: string): Promise<void> {
    await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${table}.${col}`]);
    if (table === 'ledger') await lockLedgerIds(runner);
}
